// map3 reference shots (map3 spec 13.6): the port on the prototype's own data, next to the prototype's final
// shots. Run against a production build behind `test/serve-prod.mts --fixture <PROTO>` (map.json + heat.json
// from the prototype, an idle event stream), on the M4's GPU (--use-angle=metal):
//   a  overview 1440×900                         ↔ PROTO/shots-final2/a-overview.png
//   b  $PUMP 4× (zoomTo(PUMP top, 4))            ↔ b-pump-4x.png
//   e  $Kimchi (focusFamily("Kimchi"), no selection) ↔ e-kimchi.png
//   d  phone 390×844 at DPR 2 (touch)            ↔ d-phone.png
//   h  phone, the page-pinned hover of $Kimchi (docked card)          ↔ h-phone-tooltip.png
//   f  a real mouse over the $PUMP chip at the overview               ↔ f-hover.png
//   g  a real mouse over the biggest gen-1 $PUMP child at 4×          ↔ g-hover-child-4x.png
//   mid-drag  a real mouse drag of the $PUMP top (240, −110 at the overview; 260, 90 at 4×), the frame taken
//             120 ms into the hold; afterwards ?focus is unchanged and $PUMP is back home ↔ mid-drag-*.png
// Each shot waits for settled() plus 1.5 s for logos (spec 13.6; final fix: no longer until the image queue drains, so a
// cold run shows what a first visit looks like; the share of logo cells drawn at the shot is recorded as logoCover),
// with the pointer off the map. --live-url <server with --fixture-sse live> adds a-overview-live and b-pump-4x-live:
// the same frames with the live stream's pulses and flashes, composited against the same references (the
// prototype's reference shots carried live pulses). Composites are made
// in Chrome itself (both PNGs as data: URLs in an about:blank page, screenshotted), no image library.
// Metrics per shot: labelStats().overlaps 0; limeShare() ≤ 0.001 (overview); hdrCheck() offenders 0;
// linkMaxPx() ≤ 1.5; 0 console errors. The app chrome (header, panels, rails) is in the port's shots and
// not in the prototype's, so the comparison is qualitative: the lead looks at the composites.
//
//   node --import tsx test/serve-prod.mts --dist <dist> --port 5261 --fixture <PROTO> &
//   node --import tsx test/serve-prod.mts --dist <dist> --port 5262 --fixture <PROTO> --fixture-sse live &
//   node --import tsx test/map3-shots.mts --url http://127.0.0.1:5261 --prod --ref <PROTO>/shots-final2 --out <dir> [--live-url http://127.0.0.1:5262]
//   (--ref defaults to $MAP3_PROTO/shots-final2)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LOOK, SETTLED_JS, cli, launchChrome, mapReadyJs, sleep, withDebug, type Browser, type GpuMode, type Page } from "./map3-cdp.mts";

const PROTO = process.env.MAP3_PROTO ?? "";
const { opt, has } = cli();
const BASE = opt("--url", "http://127.0.0.1:5261")!.replace(/\/$/, "");
const LIVE = (opt("--live-url", "") ?? "").replace(/\/$/, "");
const PROD = has("--prod");
// galaxy look (spec §8): `--look galaxy` (or MAP3_LOOK=galaxy) switches to the galaxy shot set a/b/c/d against the owner's
// reference PNGs in test/shots-map3-galaxy/ref/ (G-A), adds the animation proof (G-B); `--look flat --parity <baseDir>`
// adds the pixel parity of a-overview, b-pump-4x, d-phone, e-kimchi against a baseline run's PNGs (G-E).
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const GAL_DIR = join(TEST_DIR, "shots-map3-galaxy");
const REF = opt("--ref", LOOK === "galaxy" ? join(GAL_DIR, "ref") : PROTO ? join(PROTO, "shots-final2") : "")!;
if (!REF || !existsSync(REF)) { console.error("map3-shots: pass --ref <prototype shots dir> (or set MAP3_PROTO)"); process.exit(2); }
const OUT = opt("--out", LOOK === "galaxy" ? GAL_DIR : join(process.env.SPORE_TMP ?? tmpdir(), "spore-map3-shots"))!;
const PARITY = opt("--parity", null);
const PARITY_OUT = opt("--parity-out", join(OUT, "parity"))!;
// --drain-logos (implied by --parity): every settle() also waits for the logo queue to drain (≤ 30 s) so that two runs
// of the same tree show the same logos (a cold run's 1.5 s shows ~half of them, which is what the composites want)
const DRAIN = has("--drain-logos") || !!PARITY;
const GAL_GATES = { titlesA: 20, titlesD: 6, gensB: 2, lime: [0.01, 0.25], linkMaxPx: [2.5, 14], veinShareB: 0.05, veinShareC: 0.08, anim: [0.005, 0.20], animThr: 8 };
const GPU = (opt("--chrome-gpu", "metal") ?? "metal") as GpuMode;
mkdirSync(OUT, { recursive: true });
const J = JSON.stringify;
const u = (path: string) => withDebug(path, PROD);
const result: Record<string, unknown> = { url: BASE, prod: PROD, ref: REF, out: OUT, gpu: GPU, startedAt: new Date().toISOString() };
const fails: string[] = [];
const check = (c: boolean, m: string) => { if (!c) fails.push(m); return c; };
const pages: Page[] = [];
const browsers: Browser[] = [];
type Shot = { key: string; file: string; ref: string; w: number; h: number; dpr: number };
/// The engine's tooltip element: shown, docked (phone card), its text.
const TIP_JS = `(() => { const t = document.querySelector(".m3-tip"); return { on: !!t && t.classList.contains("on"), dock: !!t && t.classList.contains("dock"), text: t ? (t.textContent || "").replace(/\\s+/g, " ").slice(0, 200) : "" }; })()`;

async function openMap(p: Page, path = "/map") {
  await p.navigate(BASE + u(path), 60_000);
  await p.waitFor(mapReadyJs("three"), 120_000, `three map on ${path}`);
}
/// settled, then 1.5 s for logos (spec 13.6); the share of the engine's logo cells drawn at that moment is recorded
const logoWaits: Record<string, number> = {};
const logoCover: Record<string, { drawn: number; cells: number }> = {};
const COVER_JS = "(() => { const e = __sporeMap.eng; if (!e) return null; const n = e.coins(); let d = 0; for (let i = 0; i < n; i++) if (e.logoPx(i) > 0) d++; return { drawn: d, cells: Number(e.build().logos) || 0 }; })()";
const settle = async (p: Page, key = "") => {
  await p.waitFor(SETTLED_JS, 30_000, "settle").catch(() => null);
  if (DRAIN) await p.waitFor("(() => { const i = __sporeMap.images(); return !!i && i.queued === 0 && i.inflight === 0; })()", 20_000, "the logo queue to drain").catch(() => null);
  const t0 = Date.now();
  await sleep(1500);
  await p.waitFor(SETTLED_JS, 5_000, "settle").catch(() => null);
  if (key) { logoWaits[key] = Date.now() - t0; const c = await p.evalJs<{ drawn: number; cells: number } | null>(COVER_JS).catch(() => null); if (c) logoCover[key] = c; }
};
async function metrics(p: Page, key: string, overview: boolean) {
  // the screenshot is taken first: limeShare/hdrCheck render the scene themselves
  const m = await p.evalJs<{ labels: Record<string, number> | null; hdr: Record<string, unknown> | null; linkMaxPx: number | null; lime: number | null; titles: number; k: number }>(`({ labels: __sporeMap.labelStats(), hdr: (() => { const h = __sporeMap.hdrCheck(); return h ? { hdrPx: h.hdrPx, offenders: h.offenders, ok: h.ok, samples: (h.samples || []).slice(0, 4) } : null; })(), linkMaxPx: __sporeMap.linkMaxPx(), lime: ${overview ? "__sporeMap.limeShare()" : "null"}, titles: __sporeMap.titles().length, k: __sporeMap.zoom() })`, 60_000);
  check(!!m.labels && m.labels.overlaps === 0, `${key}: labelStats().overlaps ${m.labels?.overlaps}`);
  check(!!m.hdr && m.hdr.offenders === 0, `${key}: hdrCheck() offenders ${m.hdr?.offenders}`);
  // flat fix 2026-10-21 (spec §3.2): flat veins are ≥ 2 px at the overview and grow to a 6 px cap when opened
  check(m.linkMaxPx !== null && m.linkMaxPx >= (overview ? 2.0 : 1.5) && m.linkMaxPx <= 6.0, `${key}: linkMaxPx() ${m.linkMaxPx} (${overview ? "2.0" : "1.5"}–6.0)`);
  if (overview) check(m.lime !== null && m.lime <= 0.001, `${key}: limeShare() ${m.lime} (≤ 0.001)`);
  return m;
}

/// Galaxy gates per shot (spec §8 G-A). `which`: a overview, b $PUMP 4×, c $USDC deep, d phone.
type GM = { labels: Record<string, number> | null; hdr: { hdrPx: number; offenders: number; ok: boolean; samples: unknown[] } | null; linkMaxPx: number | null; lime: number | null; veinShare: { share: number; px: number; lit: number } | "missing" | null; titles: number; gensDom: number; k: number; look: string | null };
async function gmetrics(p: Page, key: string, which: "a" | "b" | "c" | "d"): Promise<GM> {
  const m = await p.evalJs<GM>(`(() => { const M = __sporeMap; const h = M.hdrCheck(); const vs = typeof M.veinShare === "function" ? M.veinShare() : "missing"; const gensDom = [...document.querySelectorAll(".m3 .m3-labels .lb.gen")].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden" && Number(getComputedStyle(e).opacity) > 0.05; }).length; return { labels: M.labelStats(), hdr: h ? { hdrPx: h.hdrPx, offenders: h.offenders, ok: h.ok, samples: (h.samples || []).slice(0, 4) } : null, linkMaxPx: M.linkMaxPx(), lime: ${which === "a" ? "M.limeShare()" : "null"}, veinShare: vs, titles: M.titles().length, gensDom, k: M.zoom(), look: typeof M.look === "function" ? M.look() : null }; })()`, 90_000);
  check(!!m.labels && m.labels.overlaps === 0, `${key}: labelStats().overlaps ${m.labels?.overlaps}`);
  check(!!m.labels && (m.labels.foreignColony ?? 0) === 0, `${key}: labelStats().foreignColony ${m.labels?.foreignColony}`);
  if (which === "a") check(m.titles >= GAL_GATES.titlesA, `${key}: titles() ${m.titles} (≥ ${GAL_GATES.titlesA})`);
  if (which === "d") check(m.titles >= GAL_GATES.titlesD, `${key}: titles() ${m.titles} (≥ ${GAL_GATES.titlesD})`);
  if (which === "a") check(m.lime !== null && m.lime >= GAL_GATES.lime[0] && m.lime <= GAL_GATES.lime[1], `${key}: limeShare() ${m.lime} (${GAL_GATES.lime[0]}–${GAL_GATES.lime[1]})`);
  if (which === "b") {
    const gens = Math.max(Number(m.labels?.gens ?? 0), m.gensDom);
    check(gens >= GAL_GATES.gensB, `${key}: GEN labels ${gens} (labelStats().gens ${m.labels?.gens}, .lb.gen visible ${m.gensDom}; ≥ ${GAL_GATES.gensB})`);
    check(!!m.hdr && m.hdr.hdrPx > 0, `${key}: hdrCheck().hdrPx ${m.hdr?.hdrPx} (> 0: nothing blooms)`);
    check(!!m.hdr && m.hdr.offenders === 0, `${key}: hdrCheck() offenders ${m.hdr?.offenders} (outside family discs)`);
    check(m.linkMaxPx !== null && m.linkMaxPx >= GAL_GATES.linkMaxPx[0] && m.linkMaxPx <= GAL_GATES.linkMaxPx[1], `${key}: linkMaxPx() ${m.linkMaxPx} (${GAL_GATES.linkMaxPx[0]}–${GAL_GATES.linkMaxPx[1]})`);
  }
  if (which === "b" || which === "c") {
    const need = which === "b" ? GAL_GATES.veinShareB : GAL_GATES.veinShareC;
    if (m.veinShare === "missing" || !m.veinShare) check(false, `${key}: veinShare missing (__sporeMap.veinShare() is not a function or returned ${J(m.veinShare)})`);
    else check(m.veinShare.share >= need, `${key}: veinShare() ${J(m.veinShare)} (share ≥ ${need})`);
  }
  return m;
}

/// Pixel diff of two PNGs, decoded and compared in Chrome (canvas getImageData): the share of pixels where any channel
/// differs by more than `thr`/255; `diffFile` gets a PNG (red = differing, dimmed grey = same). No image library.
type Diff = { diffPx: number; total: number; share: number; w: number; h: number; sizes: number[][]; diffFile: string | null; masked: number; diffPxInMask: number };
/// Bounding rects (image px) of the app's DOM overlays whose text the live upstream feeds (header counters, the side
/// list, the key, the tooltip): a pixel-exact parity across two runs excludes them; the map canvas itself is compared.
const MASK_SEL = "header.nav, .map-side, .map-key, .bm-key, [class*=\"map-key\"], [class*=\"legend\"], .m3-tip, .bm-controls, .bm-size, .map-pop, .map-foot, [role=\"status\"]";
const maskOf = (p: Page, dpr: number) => p.evalJs<number[][]>(`[...document.querySelectorAll(${J(MASK_SEL)})].map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0).map((r) => [Math.floor(r.left * ${dpr}), Math.floor(r.top * ${dpr}), Math.ceil(r.width * ${dpr}) + 2, Math.ceil(r.height * ${dpr}) + 2])`).catch(() => [] as number[][]);
async function diffImages(p: Page, fileA: string, fileB: string, thr: number, diffFile: string | null, mask: number[][] = []): Promise<Diff> {
  const a = readFileSync(fileA).toString("base64"), b = readFileSync(fileB).toString("base64");
  await p.viewport(64, 64, 1, false);
  await p.navigate("about:blank");
  const r = await p.evalJs<{ diffPx: number; diffPxInMask: number; masked: number; total: number; w: number; h: number; sizes: number[][]; png: string | null }>(`(async () => {
    const load = (s) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("png decode")); i.src = "data:image/png;base64," + s; });
    const [A, B] = await Promise.all([load("${a}"), load("${b}")]);
    const w = Math.min(A.naturalWidth, B.naturalWidth), h = Math.min(A.naturalHeight, B.naturalHeight);
    const px = (im) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(im, 0, 0); return g.getImageData(0, 0, w, h).data; };
    const da = px(A), db = px(B), out = ${diffFile ? "new Uint8ClampedArray(w * h * 4)" : "null"}; let n = 0, nm = 0, masked = 0;
    const M = new Uint8Array(w * h); for (const [x, y, mw, mh] of ${J(mask)}) for (let yy = Math.max(0, y); yy < Math.min(h, y + mh); yy++) for (let xx = Math.max(0, x); xx < Math.min(w, x + mw); xx++) M[yy * w + xx] = 1;
    for (let i = 0; i < w * h * 4; i += 4) {
      const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
      const diff = d > ${thr}, inMask = M[i >> 2] === 1; if (inMask) masked++;
      if (diff) { if (inMask) nm++; else n++; }
      if (out) { if (diff) { out[i] = 255; out[i + 1] = inMask ? 160 : 40; out[i + 2] = inMask ? 60 : 40; } else { const g = (da[i] * 0.3 + da[i + 1] * 0.59 + da[i + 2] * 0.11) * 0.3; out[i] = g; out[i + 1] = g; out[i + 2] = inMask ? Math.min(255, g + 40) : g; } out[i + 3] = 255; }
    }
    let png = null;
    if (out) { const c = document.createElement("canvas"); c.width = w; c.height = h; c.getContext("2d").putImageData(new ImageData(out, w, h), 0, 0); png = c.toDataURL("image/png").split(",")[1]; }
    return { diffPx: n, diffPxInMask: nm, masked, total: w * h, w, h, sizes: [[A.naturalWidth, A.naturalHeight], [B.naturalWidth, B.naturalHeight]], png };
  })()`, 120_000);
  if (diffFile && r.png) writeFileSync(diffFile, Buffer.from(r.png, "base64"));
  const total = r.total - r.masked;
  return { diffPx: r.diffPx, diffPxInMask: r.diffPxInMask, masked: r.masked, total, share: total ? r.diffPx / total : 0, w: r.w, h: r.h, sizes: r.sizes, diffFile: diffFile && r.png ? diffFile : null };
}

/// G-B animation proof: settled, logos drained, pointer parked off the canvas, idle fixture stream; two shots 500 ms apart.
async function animProof(b: Browser, p: Page, key: string, reduced: boolean) {
  // the drain wait is capped at 20 s (was 30 s): the galaxy animation sleeps 30 s after the last input (motion.js GAL_AWAKE_MS),
  // and with 2,228 family logos queued against a slow upstream the queue may not drain, so a 30 s wait measured a sleeping map
  await p.mouse("mouseMoved", 2, 2);
  await p.waitFor(SETTLED_JS, 30_000, "settle").catch(() => null);
  const drained = await p.waitFor("(() => { const i = __sporeMap.images(); return !!i && i.queued === 0 && i.inflight === 0; })()", 30_000, "the logo queue to drain").then(() => true, () => false);
  await sleep(1500);
  await p.waitFor(SETTLED_JS, 5_000, "settle").catch(() => null);
  const live0 = await p.evalJs<unknown>("__sporeMap.live()").catch(() => null);
  const r0 = await p.evalJs<number>("__sporeMap.motion().renders").catch(() => -1);
  const f1 = await p.shot(join(OUT, `${key}-1.png`));
  await sleep(500);
  const f2 = await p.shot(join(OUT, `${key}-2.png`));
  const r1 = await p.evalJs<number>("__sporeMap.motion().renders").catch(() => -1);
  const live1 = await p.evalJs<unknown>("__sporeMap.live()").catch(() => null);
  const motion = await p.evalJs<unknown>("(() => { const m = __sporeMap.motion(); return { reduced: m.reduced, why: m.why, galHz: m.galHz }; })()").catch(() => null);
  const dp = await b.newPage({ network: false });
  const d = await diffImages(dp, f1, f2, GAL_GATES.animThr, join(OUT, `${key}-diff.png`));
  await dp.close();
  const out = { ...d, reduced, drained, rendersBetween: r1 - r0, live: { before: live0, after: live1 }, motion, files: [f1, f2] };
  if (reduced) check(d.share === 0, `${key}: ${d.diffPx} of ${d.total} px changed over 500 ms under prefers-reduced-motion (must be 0)`);
  else check(d.share >= GAL_GATES.anim[0] && d.share <= GAL_GATES.anim[1], `${key}: share of pixels changed over 500 ms ${d.share.toFixed(5)} (${d.diffPx}/${d.total}; ${GAL_GATES.anim[0]}–${GAL_GATES.anim[1]})`);
  return out;
}

/// Port and prototype side by side, captioned, rendered and captured by Chrome.
async function composite(p: Page, s: Shot) {
  if (!existsSync(s.ref)) { check(false, `${s.key}: reference ${s.ref} is missing`); return null; }
  const a = readFileSync(s.file).toString("base64"), b = readFileSync(s.ref).toString("base64");
  const gap = 16, cap = 28, W = s.w * 2 + gap, H = s.h + cap;
  await p.viewport(W, H, s.dpr, false);
  await p.navigate("about:blank");
  const sizes = await p.evalJs<{ a: number[]; b: number[] }>(`(async () => {
    document.body.style.cssText = "margin:0;background:#0b0e0d;color:#b5bdb9;font:500 13px system-ui,sans-serif";
    document.body.innerHTML = '<div style="display:flex;gap:${gap}px">' +
      '<figure style="margin:0;width:${s.w}px"><figcaption style="height:${cap}px;line-height:${cap}px;padding-left:8px">port · ${s.key}</figcaption><img id="a" style="display:block;width:${s.w}px;height:${s.h}px" /></figure>' +
      '<figure style="margin:0;width:${s.w}px"><figcaption style="height:${cap}px;line-height:${cap}px;padding-left:8px">${LOOK === "galaxy" ? "reference" : "prototype"} · ${s.ref.split("/").pop()}</figcaption><img id="b" style="display:block;width:${s.w}px;height:${s.h}px" /></figure></div>';
    const A = document.getElementById("a"), B = document.getElementById("b");
    A.src = "data:image/png;base64,${a}"; B.src = "data:image/png;base64,${b}";
    await Promise.all([A.decode(), B.decode()]);
    return { a: [A.naturalWidth, A.naturalHeight], b: [B.naturalWidth, B.naturalHeight] };
  })()`, 60_000);
  const file = join(OUT, `compare-${s.key}.png`);
  await p.shot(file);
  return { file, natural: sizes };
}

try {
  const browser = await launchChrome({ gpu: GPU, width: 1440, height: 900 });
  browsers.push(browser);
  const page = await browser.newPage();
  pages.push(page);
  const shots: Shot[] = [];
  const per: Record<string, unknown> = {};
  const masks: Record<string, number[][]> = {};
  const findRoot = (symbol: string) => page.evalJs<string | null>(`(() => { const M = __sporeMap; for (const c of M.clusters(400)) { const n = M.node(c.root); if (n && n.symbol === ${J(symbol)}) return c.root; } return null; })()`);

  await openMap(page, "/map");
  const pageLook = await page.evalJs<string | null>("typeof __sporeMap.look === 'function' ? __sporeMap.look() : null").catch(() => null);
  result.look = { cli: LOOK || null, page: pageLook };
  if (LOOK === "galaxy") check(pageLook === "galaxy", `--look galaxy but __sporeMap.look() is ${J(pageLook)} (hook missing, or ?look did not reach the engine)`);
  if (LOOK === "flat") check(pageLook === "flat" || pageLook === null, `--look flat but __sporeMap.look() is ${J(pageLook)}`);
  const galaxy = pageLook === "galaxy";

  if (LOOK === "galaxy" && !galaxy) {
    // asked for the galaxy gates on a page that is not galaxy: no shots at all (the flat set would land in the galaxy folder)
  } else if (galaxy) {
    // ================= GALAXY (spec §8 G-A + G-B): a-overview, b-pump-4x (+ animation proof), c-usdc-deep, d-phone =================
    await page.mouse("mouseMoved", 2, 2);
    await page.evalJs("__sporeMap.fit()");
    await settle(page, "a-overview");
    shots.push({ key: "a-overview", file: await page.shot(join(OUT, "a-overview.png")), ref: join(REF, "ref-overview.png"), w: 1440, h: 900, dpr: 1 });
    per["a-overview"] = await gmetrics(page, "a-overview", "a");

    const pump = await findRoot("PUMP");
    if (check(!!pump, "no $PUMP family on the fixture map")) {
      await page.evalJs(`__sporeMap.zoomTo(${J(pump)}, 4)`);
      await settle(page, "b-pump-4x");
      shots.push({ key: "b-pump-4x", file: await page.shot(join(OUT, "b-pump-4x.png")), ref: join(REF, "ref-pump-4x.png"), w: 1440, h: 900, dpr: 1 });
      per["b-pump-4x"] = await gmetrics(page, "b-pump-4x", "b");
      // G-B: the veins flow / planets breathe at b with nobody touching the map
      result.animDiff = await animProof(browser, page, "anim-b-pump-4x", false);
    }

    // c: $USDC top, flown to, then zoomTo(i, 2) (the reference c-pair-2x flow)
    const usdc = await findRoot("USDC");
    if (check(!!usdc, "no $USDC family on the fixture map")) {
      await page.evalJs("__sporeMap.fit()");
      await settle(page);
      await page.evalJs(`__sporeMap.fly(${J(usdc)})`);
      await settle(page);
      // focusFamily sets the engine's focus family (no selection) so veinShare() measures $USDC's disc, not the largest planet
      per["c-focus"] = await page.evalJs<unknown>(`__sporeMap.focusFamily("USDC")`, 20_000).catch(() => null);
      await settle(page);
      // (integrator) a DEEP zoom: zoomTo's factor is relative to k0, and on this fixture k0 is ~0.34 px/u (the galaxy layout is
      // ~3.7x wider than the flat one), so "2" would show the whole map; take 2x the family-framing zoom focusFamily arrived at.
      const kFocus = await page.evalJs<number>("__sporeMap.zoom()").catch(() => 0);
      per["c-kFocus"] = kFocus;
      await page.evalJs(`__sporeMap.zoomTo(${J(usdc)}, ${Math.max(2, 2 * (Number(kFocus) || 0))})`);
      await settle(page, "c-usdc-deep");
      shots.push({ key: "c-usdc-deep", file: await page.shot(join(OUT, "c-usdc-deep.png")), ref: join(REF, "ref-usdc-deep.png"), w: 1440, h: 900, dpr: 1 });
      per["c-usdc-deep"] = await gmetrics(page, "c-usdc-deep", "c");
    }

    // d: phone (no phone reference from the owner: composited against the overview reference, qualitative)
    const phone = await browser.newPage({ width: 390, height: 844, dpr: 2, mobile: true, touch: true });
    pages.push(phone);
    await openMap(phone, "/map");
    await settle(phone, "d-phone");
    shots.push({ key: "d-phone", file: await phone.shot(join(OUT, "d-phone.png")), ref: join(REF, "ref-overview.png"), w: 390, h: 844, dpr: 2 });
    per["d-phone"] = await gmetrics(phone, "d-phone", "d");
    await phone.close();

    // G-B under prefers-reduced-motion: the same two frames at b must be identical
    const rb = await launchChrome({ gpu: GPU, width: 1440, height: 900, reducedMotion: true });
    browsers.push(rb);
    const rp = await rb.newPage();
    pages.push(rp);
    await openMap(rp, "/map");
    await rp.mouse("mouseMoved", 2, 2);
    if (pump) await rp.evalJs(`__sporeMap.zoomTo(${J(pump)}, 4)`);
    await settle(rp, "anim-reduced");
    result.animDiffReduced = await animProof(rb, rp, "anim-reduced-b-pump-4x", true);
    await rp.close();
  } else {

  // a: overview
  await page.mouse("mouseMoved", 2, 2);
  await page.evalJs("__sporeMap.fit()");
  await settle(page, "a-overview");
  shots.push({ key: "a-overview", file: await page.shot(join(OUT, "a-overview.png")), ref: join(REF, "a-overview.png"), w: 1440, h: 900, dpr: 1 });
  masks["a-overview"] = await maskOf(page, 1);
  per["a-overview"] = await metrics(page, "a-overview", true);

  // b: $PUMP 4×
  const pump = await page.evalJs<string | null>(`(() => { const M = __sporeMap; for (const c of M.clusters(200)) { const n = M.node(c.root); if (n && n.symbol === "PUMP") return c.root; } return null; })()`);
  if (check(!!pump, "no $PUMP family on the fixture map")) {
    await page.evalJs(`__sporeMap.zoomTo(${J(pump)}, 4)`);
    await settle(page, "b-pump-4x");
    shots.push({ key: "b-pump-4x", file: await page.shot(join(OUT, "b-pump-4x.png")), ref: join(REF, "b-pump-4x.png"), w: 1440, h: 900, dpr: 1 });
    masks["b-pump-4x"] = await maskOf(page, 1);
    per["b-pump-4x"] = await metrics(page, "b-pump-4x", false);
  }

  // e: $Kimchi framed, nothing selected
  await page.evalJs("__sporeMap.fit()");
  await settle(page);
  const fam = await page.evalJs<unknown>(`__sporeMap.focusFamily("Kimchi")`, 20_000);
  await settle(page, "e-kimchi");
  const sel = await page.evalJs<string | null>("__sporeMap.selected()");
  check(sel === null, `e-kimchi: focusFamily selected ${sel}`);
  shots.push({ key: "e-kimchi", file: await page.shot(join(OUT, "e-kimchi.png")), ref: join(REF, "e-kimchi.png"), w: 1440, h: 900, dpr: 1 });
  masks["e-kimchi"] = await maskOf(page, 1);
  per["e-kimchi"] = { focusFamily: fam, ...(await metrics(page, "e-kimchi", false)) };

  // d: phone
  const phone = await browser.newPage({ width: 390, height: 844, dpr: 2, mobile: true, touch: true });
  pages.push(phone);
  await openMap(phone, "/map");
  await settle(phone, "d-phone");
  shots.push({ key: "d-phone", file: await phone.shot(join(OUT, "d-phone.png")), ref: join(REF, "d-phone.png"), w: 390, h: 844, dpr: 2 });
  masks["d-phone"] = await maskOf(phone, 2);
  per["d-phone"] = await metrics(phone, "d-phone", false);

  // h: phone tooltip (the page-pinned hover of $Kimchi → the docked card), as the prototype's __hover("Kimchi")
  const hk = await phone.evalJs<unknown>(`__sporeMap.hover("Kimchi")`);
  await sleep(2000);
  const dock = await phone.evalJs<{ on: boolean; dock: boolean; text: string }>(TIP_JS);
  check(dock.on && dock.dock, `h-phone-tooltip: docked card ${J(dock)}`);
  // (final fix) the card does not cover its coin (the camera nudges it above), and the +/- column steps aside
  const clear = await phone.evalJs<{ coinBottom: number; cardTop: number; controls: string } | null>(`(() => { const s = __sporeMap.screenOf(__sporeMap.hovered()); const t = document.querySelector(".m3-tip.dock.on"); const c = document.querySelector(".m3 .bm-controls"); if (!s || !t) return null; return { coinBottom: Math.round(s.y + s.r), cardTop: Math.round(t.getBoundingClientRect().top), controls: c ? getComputedStyle(c).visibility : "none" }; })()`);
  check(!!clear && clear.coinBottom <= clear.cardTop, `h-phone-tooltip: the card covers its coin ${J(clear)}`);
  check(!!clear && clear.controls !== "visible", `h-phone-tooltip: the +/- column stays under the card ${J(clear)}`);
  shots.push({ key: "h-phone-tooltip", file: await phone.shot(join(OUT, "h-phone-tooltip.png")), ref: join(REF, "h-phone-tooltip.png"), w: 390, h: 844, dpr: 2 });
  per["h-phone-tooltip"] = { hover: hk, tip: dock, clear };
  await phone.close();

  // f: a real mouse over the $PUMP chip at the overview (prototype: pointermove at the top's point + (2, 1))
  if (pump) {
    await page.evalJs("__sporeMap.fit()");
    await settle(page);
    const pt = await page.evalJs<{ x: number; y: number; r: number } | null>(`__sporeMap.screenOf(${J(pump)})`);
    if (check(!!pt, "f-hover: no $PUMP point")) {
      await page.mouse("mouseMoved", pt!.x + 2, pt!.y + 1);
      await sleep(1500);
      const tip = await page.evalJs<{ on: boolean; dock: boolean; text: string }>(TIP_JS);
      check(tip.on && /Market cap/.test(tip.text), `f-hover: tooltip ${J(tip)}`);
      shots.push({ key: "f-hover", file: await page.shot(join(OUT, "f-hover.png")), ref: join(REF, "f-hover.png"), w: 1440, h: 900, dpr: 1 });
      per["f-hover"] = { point: pt, hovered: await page.evalJs("__sporeMap.hovered()"), tip };
      await page.mouse("mouseMoved", 2, 2);
      await sleep(400);
    }

    // g: a real mouse over the biggest gen-1 $PUMP child drawn ≥ 6 px near the middle, at 4×
    await page.evalJs(`__sporeMap.zoomTo(${J(pump)}, 4)`);
    await settle(page);
    const child = await page.evalJs<{ mint: string; x: number; y: number; r: number } | null>(`(() => { const M = __sporeMap; let best = null; for (const m of M.children(${J(pump)})) { const s = M.screenOf(m); if (!s || s.r < 6 || s.x < 350 || s.x > 1090 || s.y < 250 || s.y > 650) continue; const el = document.elementFromPoint(s.x, s.y); if (!el || !el.classList.contains("m3-canvas")) continue; if (!best || s.r > best.r) best = { mint: m, ...s }; } return best; })()`);
    if (check(!!child, "g-hover-child-4x: no child drawn ≥ 6 px")) {
      await page.mouse("mouseMoved", child!.x + 1, child!.y + 1);
      await sleep(1500);
      const tip = await page.evalJs<{ on: boolean; dock: boolean; text: string }>(TIP_JS);
      check(tip.on, `g-hover-child-4x: tooltip ${J(tip)}`);
      shots.push({ key: "g-hover-child-4x", file: await page.shot(join(OUT, "g-hover-child-4x.png")), ref: join(REF, "g-hover-child-4x.png"), w: 1440, h: 900, dpr: 1 });
      per["g-hover-child-4x"] = { child, hovered: await page.evalJs("__sporeMap.hovered()"), tip };
      await page.mouse("mouseMoved", 2, 2);
      await sleep(400);
    }

    // mid-drag: a real mouse drag of the $PUMP top (prototype: 240, -110 at the overview; 260, 90 at 4×; 70 moves,
    // the frame taken 120 ms into the hold), then released; the drag must not select and every coin goes home
    const midDrag = async (key: string, dx: number, dy: number) => {
      await settle(page);
      const p0 = await page.evalJs<{ x: number; y: number; r: number } | null>(`__sporeMap.screenOf(${J(pump)})`);
      if (!check(!!p0, `${key}: no $PUMP point`)) return;
      const focus0 = await page.evalJs<string | null>(`new URLSearchParams(location.search).get("focus")`);
      await page.mouse("mouseMoved", p0!.x, p0!.y);
      await page.mouse("mousePressed", p0!.x, p0!.y);
      for (let i = 1; i <= 70; i++) { await page.mouse("mouseMoved", p0!.x + (dx * i) / 70, p0!.y + (dy * i) / 70, { button: "left", buttons: 1 }); await sleep(7); }
      await sleep(120);
      const held = await page.evalJs<Record<string, unknown> | null>("__sporeMap.drag()");
      const file = await page.shot(join(OUT, `${key}.png`));
      await sleep(380);
      await page.mouse("mouseReleased", p0!.x + dx, p0!.y + dy);
      const rest = await page.waitFor(SETTLED_JS + " && !__sporeMap.drag()", 15_000, "the rest").then(() => true, () => false);
      await sleep(2200);
      const focus1 = await page.evalJs<string | null>(`new URLSearchParams(location.search).get("focus")`);
      const p1 = await page.evalJs<{ x: number; y: number } | null>(`__sporeMap.screenOf(${J(pump)})`);
      check(!!held, `${key}: drag() was null while held`);
      check(rest, `${key}: the map did not come to rest`);
      check(focus1 === focus0, `${key}: the drag changed ?focus ${focus0} → ${focus1}`);
      const home = !!p1 && Math.hypot(p1.x - p0!.x, p1.y - p0!.y) < 0.5;
      check(home, `${key}: $PUMP did not return home (${J(p0)} → ${J(p1)})`);
      shots.push({ key, file, ref: join(REF, `${key}.png`), w: 1440, h: 900, dpr: 1 });
      per[key] = { from: p0, by: [dx, dy], held, rest, homePx: p1 ? +Math.hypot(p1.x - p0!.x, p1.y - p0!.y).toFixed(3) : null, focus: focus1 };
    };
    await page.evalJs("__sporeMap.fit()");
    await midDrag("mid-drag-overview", 240, -110);
    await page.evalJs(`__sporeMap.zoomTo(${J(pump)}, 4)`);
    await midDrag("mid-drag-4x", 260, 90);
  }

  // (final fix) the same overview and $PUMP 4× frames with the live stream (pulses, flashes, toasts)
  if (LIVE) {
    const lp = await browser.newPage();
    pages.push(lp);
    await lp.navigate(LIVE + u("/map"), 60_000);
    await lp.waitFor(mapReadyJs("three"), 120_000, "three map (live)");
    await lp.mouse("mouseMoved", 2, 2);
    await lp.evalJs("__sporeMap.fit()");
    await settle(lp, "a-overview-live");
    await lp.waitFor("(() => { const l = __sporeMap.live(); return !!l && l.events > 0; })()", 20_000, "live events").catch(() => null);
    await sleep(2500);
    shots.push({ key: "a-overview-live", file: await lp.shot(join(OUT, "a-overview-live.png")), ref: join(REF, "a-overview.png"), w: 1440, h: 900, dpr: 1 });
    per["a-overview-live"] = { live: await lp.evalJs("__sporeMap.live()"), ...(await metrics(lp, "a-overview-live", false)) };
    if (pump) {
      await lp.evalJs(`__sporeMap.zoomTo(${J(pump)}, 4)`);
      await settle(lp, "b-pump-4x-live");
      await sleep(2500);
      shots.push({ key: "b-pump-4x-live", file: await lp.shot(join(OUT, "b-pump-4x-live.png")), ref: join(REF, "b-pump-4x.png"), w: 1440, h: 900, dpr: 1 });
      per["b-pump-4x-live"] = { live: await lp.evalJs("__sporeMap.live()"), ...(await metrics(lp, "b-pump-4x-live", false)) };
    }
    await lp.close();
  }

  // G-E flat parity: the same frames as a baseline run (today's tree) must be pixel-identical under ?look=flat
  if (PARITY) {
    mkdirSync(PARITY_OUT, { recursive: true });
    const readJson = (f: string) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
    const baseJson = readJson(join(PARITY, "map3-shots.json"));
    const finalJson = readJson(join(TEST_DIR, "shots-map3-final", "map3-shots.json"));
    const dp = await browser.newPage({ network: false });
    pages.push(dp);
    const parity: Record<string, unknown> = {};
    for (const key of ["a-overview", "b-pump-4x", "d-phone", "e-kimchi"]) {
      const mine = join(OUT, `${key}.png`), base = join(PARITY, `${key}.png`);
      if (!existsSync(base) || !existsSync(mine)) { check(false, `${key}: parity needs ${base} and ${mine}`); continue; }
      const d = await diffImages(dp, mine, base, 0, join(PARITY_OUT, `${key}-diff.png`), masks[key] ?? []);
      const pm = per[key] as { hdr?: { hdrPx?: number }; linkMaxPx?: number | null; lime?: number | null } | undefined;
      const fm = finalJson?.metrics?.[key] as { hdr?: { hdrPx?: number }; linkMaxPx?: number | null; lime?: number | null } | undefined;
      parity[key] = { shot: key, diffPx: d.diffPx, total: d.total, share: d.share, masked: d.masked, diffPxInMask: d.diffPxInMask, maskRects: masks[key] ?? [], sizes: d.sizes, diffFile: d.diffFile, logoCover: { base: baseJson?.logoCover?.[key] ?? null, final: logoCover[key] ?? null }, metrics: { final: pm ? { hdrPx: pm.hdr?.hdrPx, linkMaxPx: pm.linkMaxPx, lime: pm.lime } : null, reference: fm ? { hdrPx: fm.hdr?.hdrPx, linkMaxPx: fm.linkMaxPx, lime: fm.lime } : null } };
      check(d.diffPx === 0, `${key}: flat parity ${d.diffPx} of ${d.total} map px differ from ${base} (${d.diffPxInMask} more inside the masked DOM overlays) (diff ${d.diffFile}; logoCover base ${J(baseJson?.logoCover?.[key] ?? null)} vs final ${J(logoCover[key] ?? null)})`);
      // hdrPx counts logo pixels too (it moves with the logos drawn), so only linkMaxPx is compared exactly; hdr offenders
      // 0 and lime ≤ 0.001 are already gated by metrics()
      if (pm && fm) check(pm.linkMaxPx === fm.linkMaxPx, `${key}: flat linkMaxPx ${pm.linkMaxPx} ≠ shots-map3-final ${fm.linkMaxPx}`);
    }
    try { writeFileSync(join(PARITY_OUT, "parity.json"), JSON.stringify(parity, null, 2)); } catch { /* optional */ }
    result.parity = parity;
    await dp.close();
  }
  }   // flat

  // composites
  const comp = await browser.newPage({ network: false });
  pages.push(comp);
  const composites: Record<string, unknown> = {};
  for (const s of shots) composites[s.key] = await composite(comp, s);
  await comp.close();
  result.shots = shots.map((s) => s.file);
  result.metrics = per;
  result.logoWaitMs = logoWaits;
  result.logoCover = logoCover;
  result.images = await page.evalJs("__sporeMap.images()").catch(() => null);
  result.composites = composites;
} catch (e) {
  fails.push(`crashed: ${(e as Error).message}`);
} finally {
  const errors = pages.flatMap((p) => p.errors);
  result.consoleErrors = errors;
  result.networkErrors = pages.flatMap((p) => p.netErrors).slice(0, 30);
  if (errors.length) fails.push(`${errors.length} console error(s): ${errors.slice(0, 3).join(" | ")}`);
  result.failures = fails;
  result.ok = fails.length === 0;
  const text = JSON.stringify(result, null, 2);
  try { writeFileSync(join(OUT, "map3-shots.json"), text); } catch { /* optional */ }
  console.log(text);
  for (const b of browsers) await b.close();
}
process.exit(fails.length ? 1 : 0);
