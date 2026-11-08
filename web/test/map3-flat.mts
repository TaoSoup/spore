// map3 FLAT-look gates (flat-fix spec 2026-10-21 §5): the owner's five items on the map sporepad.com shows.
//   G1 logos  G2 veins  G3 far bubbles  G4 size by mcap  G5 every child visible  (+ C1 the coin page tree's logos)
// Each value is printed next to its gate and written as JSON (<out>/flat-gates-<tag>.json, merged into --json, default
// $SPORE_QA/flat-gates.json or <out>/flat-gates.json). The overview is the settled first load of /map?debug WITHOUT a
// look param (proves the default) unless --look is given; __sporeMap.look() must be "flat". 4× = zoomTo($PUMP top, 4).
//   node --import tsx test/map3-flat.mts --url https://127.0.0.1:5642 --out <dir> [--tag live-h2] [--phone]
//        [--size-url <serve-prod on S/size-fixture>] [--base-url <serve-prod on S/mapThree>] [--coin] [--only G1,G2,...]
// The engine debug fns (bubbles: coverage, topVis, kidVis, nodePx, logoCoverage; veins: linkMaxPx, linkMinPx, veinAlpha)
// are read through __sporeMap.call(name, ...); a missing one is FAIL "missing". An https URL (serve-prod --h2) makes
// Chrome ignore the self-signed cert (map3-cdp.mts). Logo timing gates need --h2 (over HTTP/1.1 Chrome's 6-socket cap queues
// the loads and the numbers are the harness's, not the site's).
// (repair, look fix 2026-10-22) G2 is keyed to the ACCEPTED hairline look (linkMaxPx <= 1.8, inkShare <= 0.05, rim ink
// <= 0.3, veinShare <= 0.02, white-wash <= 0.03) at rest AND under interaction (hover / selection of $PUMP and $Kimchi,
// ring scans around the top); G1's overview share is roots6Drawn + roots6Dead over roots6 (tops drawn at the logo threshold).
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOOK, SETTLED_JS, cli, launchChrome, mapReadyJs, sleep, withDebug, type Page } from "./map3-cdp.mts";

const req = createRequire(import.meta.url);
const pngjs = req("pngjs") as { PNG: { sync: { read(b: Buffer): { width: number; height: number; data: Buffer } } } };
const { opt, has } = cli();
const BASE = (opt("--url", "http://127.0.0.1:5640") ?? "").replace(/\/$/, "");
const OUT = opt("--out", join(process.env.SPORE_TMP ?? "/tmp", "spore-map3-flat"))!;
const PHONE = has("--phone");
const TAG = opt("--tag", PHONE ? "phone" : "desktop")!;
const JSON_OUT = opt("--json", process.env.SPORE_QA ? join(process.env.SPORE_QA, "flat-gates.json") : join(OUT, "flat-gates.json"))!;
const SIZE_URL = opt("--size-url", null), BASE_URL = opt("--base-url", null);
const ONLY = new Set((opt("--only", "") ?? "").split(",").filter(Boolean));
const want = (g: string) => !ONLY.size || ONLY.has(g);
const COIN = has("--coin") || ONLY.has("C1");
const PUMP_SYM = "PUMP", KIMCHI = "CSocnzcRpgSCr1naKcNTieWZUxb6rABe45j844m7pump";
const CARDS = "CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp", POKEMON = "D42TjMjz5H7toPu5md5KBXreZkCSdZMEfLQwmBhJXvb1";
const BATON = "Hg5Ja55T5wESq4vyFoiVCMeHXtGyVA69X2UHq8hgpump";
mkdirSync(OUT, { recursive: true });
const J = JSON.stringify;

type Row = { id: string; value: unknown; gate: string; pass: boolean | null; note?: string };
const rows: Row[] = [];
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/// one gate row; pass null = not measured (missing hook → FAIL "missing" unless skipped on purpose)
function gate(id: string, value: unknown, gateText: string, ok: boolean | null, note?: string) {
  const r: Row = { id, value, gate: gateText, pass: ok, ...(note ? { note } : {}) };
  rows.push(r);
  console.log(`${ok === null ? "SKIP" : ok ? "PASS" : "FAIL"}  ${id.padEnd(28)} ${String(typeof value === "number" ? +value.toFixed(4) : J(value)).slice(0, 90).padEnd(30)} gate ${gateText}${note ? `  (${note})` : ""}`);
}
const missing = (id: string, gateText: string, what: string) => { rows.push({ id, value: null, gate: gateText, pass: false, note: `missing: ${what}` }); console.log(`FAIL  ${id.padEnd(28)} missing ${what}`); };

async function settle(p: Page, ms = 1500) { await p.waitFor(SETTLED_JS, 30_000, "settle").catch(() => null); await sleep(ms); await p.waitFor(SETTLED_JS, 5_000, "settle").catch(() => null); }
const call = <T,>(p: Page, name: string, ...a: unknown[]) => p.evalJs<T | null>(`(() => { try { const r = __sporeMap.call(${J(name)}${a.map((x) => `, ${J(x)}`).join("")}); return r === undefined ? null : r; } catch (e) { return null; } })()`, 60_000).catch(() => null);
const vsOf = (v: unknown): number | null => (typeof v === "number" ? v : v && typeof v === "object" && typeof (v as { share?: unknown }).share === "number" ? (v as { share: number }).share : null);
type Img = { w: number; h: number; d: Buffer };
async function shot(p: Page, name: string): Promise<Img> {
  const r = await p.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
  const buf = Buffer.from(r.data, "base64"); writeFileSync(join(OUT, `${TAG}-${name}.png`), buf);
  const png = pngjs.PNG.sync.read(buf); return { w: png.width, h: png.height, d: png.data };
}
/// share of pixels inside the circle (page CSS px; sc = device px per CSS px) with min(R,G,B) ≥ 200
function whiteShare(img: Img, c: { x: number; y: number; r: number } | null, sc: number): { share: number; px: number } | null {
  if (!c || !(c.r > 0)) return null;
  const cx = c.x * sc, cy = c.y * sc, r = c.r * sc;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(img.w - 1, Math.ceil(cx + r)), y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(img.h - 1, Math.ceil(cy + r));
  let n = 0, w = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
    const i = (y * img.w + x) * 4; n++;
    if (Math.min(img.d[i], img.d[i + 1], img.d[i + 2]) >= 200) w++;
  }
  return n ? { share: w / n, px: n } : null;
}
/// share (%) of lit pixels (lum > thr) on the circle of radius r (device px) around (cx, cy)
function ringLit(img: Img, cx: number, cy: number, r: number, thr = 35): number {
  const n = Math.max(64, Math.round(2 * Math.PI * r)); let lit = 0;
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n, x = Math.round(cx + r * Math.cos(a)), y = Math.round(cy + r * Math.sin(a));
    if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue;
    const q = (y * img.w + x) * 4;
    if (0.2126 * img.d[q] + 0.7152 * img.d[q + 1] + 0.0722 * img.d[q + 2] > thr) lit++;
  }
  return +((100 * lit) / n).toFixed(1);
}
/// share (%) of pixels with lum > thr inside the rect [x0, y0, x1, y1] (device px)
function lumShare(img: Img, rect: [number, number, number, number], thr = 40): number {
  const [x0, y0, x1, y1] = rect.map((v) => Math.round(v)); let n = 0, lit = 0;
  for (let y = Math.max(0, y0); y < Math.min(img.h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(img.w, x1); x++) {
    const q = (y * img.w + x) * 4; n++;
    if (0.2126 * img.d[q] + 0.7152 * img.d[q + 1] + 0.0722 * img.d[q + 2] > thr) lit++;
  }
  return n ? +((100 * lit) / n).toFixed(2) : 0;
}
/// G2 vein gates on a veinAlpha() record: the family's ink share of its disc and the top's rim ink (alpha-weighted share of the rim)
function veinGates(label: string, va: Record<string, unknown> | null) {
  const ink = num(va?.inkShare), rim = va && typeof va.rim === "object" && va.rim ? num((va.rim as { ink?: unknown }).ink) : null;
  if (!va) { missing(`G2 inkShare ${label}`, "≤ 0.05", "veinAlpha"); return; }
  gate(`G2 inkShare ${label}`, ink, `≤ 0.05 (n ${va.n}, p50 ${va.p50}, max ${va.max})`, ink !== null && ink <= 0.05);
  gate(`G2 rim ink ${label}`, rim, `≤ 0.3 (rim ${J((va.rim as { n?: unknown; px?: unknown; geo?: unknown } | null)?.n)} veins at ${J((va.rim as { px?: unknown } | null)?.px)} px, geo ${J((va.rim as { geo?: unknown } | null)?.geo)})`, rim !== null && rim <= 0.3);
}
const rootOfJs = (sym: string) => `(() => { for (const c of __sporeMap.clusters(100000)) { const n = __sporeMap.node(c.root) || {}; if (n.symbol === ${J(sym)}) return c.root; } return null; })()`;
/// the size toggle: which button is pressed, and the URL's size param
const SIZE_UI_JS = `(() => { const b = [...document.querySelectorAll(".bm-size button")]; const on = b.filter((x) => x.getAttribute("aria-pressed") === "true").map((x) => x.textContent.trim()); return { pressed: on, buttons: b.length, sizeParam: new URLSearchParams(location.search).get("size") }; })()`;
/// HTTP protocol of the /api/img fetches (Resource Timing nextHopProtocol: h2 vs http/1.1)
const PROTO_JS = `(() => { const h = {}; for (const e of performance.getEntriesByType("resource")) { if (!/\\/api\\/img/.test(e.name)) continue; const k = e.nextHopProtocol || "?"; h[k] = (h[k] || 0) + 1; } return h; })()`;

const result: Record<string, unknown> = { url: BASE, tag: TAG, phone: PHONE, look: LOOK || null, at: new Date().toISOString() };

async function mainRun() {
  const br = await launchChrome(PHONE ? { gpu: "metal", width: 390, height: 844, dpr: 2, mobile: true, touch: true } : { gpu: "metal", width: 1440, height: 900 });
  const p = await br.newPage(PHONE ? { width: 390, height: 844, dpr: 2, mobile: true, touch: true } : { width: 1440, height: 900, dpr: 1 });
  const SC = PHONE ? 2 : 1;
  try {
    await p.navigate(BASE + withDebug("/map"), 60_000);
    await p.waitFor(mapReadyJs("three"), 120_000, "three map");
    const look = await p.evalJs<string | null>("__sporeMap.look ? __sporeMap.look() : null");
    result.pageLook = look;
    gate("default look", look, `== "flat"${LOOK ? ` (--look ${LOOK})` : " (no look param)"}`, look === "flat");

    // ---------------- G1 logos: cold profile, logoCoverage every 1 s for 8 s after first paint
    if (want("G1") && !PHONE) {
      const series: Record<string, unknown>[] = [];
      let last: Record<string, number> | null = null;
      for (;;) {
        const since = await p.evalJs<number>("performance.now() - __sporeMap.firstPaintAt()");
        last = await call<Record<string, number>>(p, "logoCoverage");
        const im = await p.evalJs<Record<string, number>>("__sporeMap.images()");
        series.push({ t: Math.round(since), on: last?.rootsOnScreen, img: last?.rootsWithImage, drawn: last?.rootsDrawn, pending: last?.pending, im: im && { ready: im.ready, inflight: im.inflight, queued: im.queued, e429: im.e429, thumbs: im.thumbs, maxInflight: im.maxInflight } });
        if (since >= 8000) break;
        await sleep(Math.min(1000, Math.max(50, 8000 - since)));
      }
      result.logoSeries = series;
      const im = await p.evalJs<Record<string, number>>("__sporeMap.images()");
      result.images8s = im;
      result.imgProtocols = await p.evalJs(PROTO_JS);
      const s429 = p.responses.filter((r) => r.status === 429).length;
      result.http4xx = { n: p.responses.length, s429, sample: p.responses.slice(0, 5) };
      if (!last) missing("G1 roots logo share @8s", "≥ 0.90", "logoCoverage");
      else {
        // (repair, look fix 2026-10-22) the accepted overview draws a dust-family top as a 1.2-2 px speck (no logo until it is
        // drawn >= LOGO_MIN_PX on zoom), so the share is over the tops DRAWN AT OR ABOVE the logo threshold (roots6): drawn,
        // or dead (no image / the loader gave up) — the done condition roots6Drawn + roots6Dead == roots6, 90 % of it by 8 s
        const r6 = num(last.roots6) ?? 0, done = (num(last.roots6Drawn) ?? 0) + (num(last.roots6Dead) ?? 0);
        const share = r6 ? done / r6 : 0;
        gate("G1 roots logo share @8s", share, `≥ 0.90 ((drawn ${last.roots6Drawn} + dead ${last.roots6Dead}) / roots6 ${last.roots6}; tops on screen ${last.rootsOnScreen}, drawn ${last.rootsDrawn})`, r6 > 0 && share >= 0.9, `proto ${J(result.imgProtocols)}`);
      }
      gate("G1 images().e429", num(im?.e429), "== 0", num(im?.e429) === 0);
      gate("G1 HTTP 429 (CDP)", s429, "== 0", s429 === 0);
      if (im && "maxInflight" in im) gate("G1 images().maxInflight", im.maxInflight, "96 desktop / 32 phone", im.maxInflight === (PHONE ? 32 : 96));
    }

    // ---------------- overview (settled first load)
    await p.mouse("mouseMoved", 2, 2);
    await settle(p, 2500);
    const pump = await p.evalJs<string | null>(rootOfJs(PUMP_SYM));
    result.pump = pump;
    result.k0 = await p.evalJs("__sporeMap.zoom()");
    const sizeUi = await p.evalJs<{ pressed: string[]; buttons: number; sizeParam: string | null }>(SIZE_UI_JS);
    result.sizeUi = sizeUi;
    if (want("G4")) gate("G4 size control", sizeUi, `no size control (market cap only), no size param`, sizeUi.buttons === 0 && sizeUi.sizeParam === null);
    const imgA = await shot(p, "overview");
    if (want("G1") && !PHONE) {
      // (fixer) what the owner sees from far: tops drawn at or above the logo threshold, and how many show a logo
      const lv = await call<Record<string, number>>(p, "logoCoverage");
      result.logoOverview = lv;
      if (!lv || num(lv.roots6) === null) missing("G1 visible logos overview", "reported", "logoCoverage.roots6");
      else gate("G1 visible logos overview", lv.roots6Drawn, `reported (tops ≥ logo threshold ${lv.roots6}, with a logo ${lv.roots6Drawn}, of ${lv.rootsOnScreen} on screen)`, null);
    }

    if (want("G3")) {
      const cov = await call<Record<string, unknown>>(p, "coverage");
      result.coverage = cov;
      if (!cov) missing("G3 coverage", "onScreen == tops, minTopPx ≥ 3", "coverage");
      else {
        const tops = num(cov.tops), on = num(cov.onScreen), mn = num(cov.minTopPx);
        gate("G3 tops on screen", `${on}/${tops}`, "onScreen == tops", tops !== null && on === tops, cov.allOnScreen === undefined ? "allOnScreen field missing" : `allOnScreen ${cov.allOnScreen}`);
        gate("G3 minTopPx", mn, PHONE ? "≥ 2.5 (phone)" : "≥ 3", mn !== null && mn >= (PHONE ? 2.5 : 3), cov.minTopPxOnScreen !== undefined ? `minTopPxOnScreen ${cov.minTopPxOnScreen}` : "minTopPxOnScreen missing");
      }
      if (!PHONE) {
        const tv = await call<Record<string, number>>(p, "topVis");
        result.topVis = tv;
        if (!tv) missing("G3 topVis share", "≥ 0.95", "topVis");
        else gate("G3 topVis share", tv.share, `≥ 0.95 (lit ${tv.lit}/${tv.onScreen}, p10Max ${tv.p10Max})`, tv.share >= 0.95);
      }
    }
    if (PHONE) return;

    const famPump = pump ? await p.evalJs<{ x: number; y: number; r: number } | null>(`__sporeMap.familyScreen(${J(pump)})`) : null;
    const famKim = await p.evalJs<{ x: number; y: number; r: number } | null>(`__sporeMap.familyScreen(${J(KIMCHI)})`).catch(() => null);
    if (want("G2")) {
      const lmax = await call<number>(p, "linkMaxPx") ?? await p.evalJs<number | null>("__sporeMap.linkMaxPx()");
      const lmin = await call<number>(p, "linkMinPx", PUMP_SYM);
      const vs = vsOf(await p.evalJs<unknown>(`(() => { try { return __sporeMap.eng.veinShare(${J(PUMP_SYM)}); } catch (e) { return null; } })()`));
      const va = await call<Record<string, number>>(p, "veinAlpha", PUMP_SYM);
      result.overviewVeins = { linkMaxPx: lmax, linkMinPx: lmin, veinShare: vs, veinAlpha: va };
      // (repair, look fix 2026-10-22) G2 re-based to the ACCEPTED look (the owner: hairlines, "the previous site looked better"):
      // the 2026-10-21 starburst thresholds (linkMaxPx >= 2, linkMinPx >= 1.5, veinShare 0.04..0.45, gen-1 alpha >= 0.45) are
      // the rejected look. Veins are at most 1.8 px, light a tiny share of the family disc, and the top's brood never inks
      // more than 30 % of its rim; the white-wash gates stay.
      if (num(lmax) === null) missing("G2 linkMaxPx overview", "≤ 1.8", "linkMaxPx"); else gate("G2 linkMaxPx overview", lmax, "≤ 1.8", lmax! <= 1.8);
      gate("G2 linkMinPx($PUMP) overview", lmin, "reported (hairline core at the far end, CSS px)", null);
      if (num(vs) === null) missing("G2 veinShare($PUMP) overview", "≤ 0.02", "veinShare"); else gate("G2 veinShare($PUMP) overview", vs, "≤ 0.02", vs! <= 0.02);
      veinGates("overview", va);
      const wp = whiteShare(imgA, famPump, SC), wk = whiteShare(imgA, famKim, SC);
      result.whiteOverview = { pump: wp, kimchi: wk, famPump, famKim };
      gate("G2 white $PUMP overview", wp?.share ?? null, "≤ 0.03", wp ? wp.share <= 0.03 : false, wp ? `${wp.px} px` : "no disc");
      gate("G2 white $Kimchi overview", wk?.share ?? null, "≤ 0.03", wk ? wk.share <= 0.03 : false, wk ? `${wk.px} px` : "no disc");
    }
    if (want("G5")) {
      const kv = await call<Record<string, unknown>>(p, "kidVis", PUMP_SYM);
      result.kidVisOverview = kv;
      if (!kv) missing("G5 kidVis($PUMP) overview", "≥ 0.80", "kidVis");
      else gate("G5 kidVis($PUMP) overview", kv.share, `≥ 0.80 (visible ${kv.visible}/${kv.inRect ?? kv.kids})`, num(kv.share) !== null && (kv.share as number) >= 0.8);
    }

    // ---------------- $PUMP 4×
    if (pump && (want("G1") || want("G2") || want("G5"))) {
      await p.evalJs(`__sporeMap.zoomTo(${J(pump)}, 4)`);
      await settle(p, 2500);
      result.k4 = await p.evalJs("__sporeMap.zoom()");
      const imgB = await shot(p, "pump-4x");
      if (want("G2")) {
        const vs = vsOf(await p.evalJs<unknown>(`(() => { try { return __sporeMap.eng.veinShare(${J(PUMP_SYM)}); } catch (e) { return null; } })()`));
        const lmax = await call<number>(p, "linkMaxPx") ?? await p.evalJs<number | null>("__sporeMap.linkMaxPx()");
        const lmin = await call<number>(p, "linkMinPx", PUMP_SYM), va = await call<Record<string, number>>(p, "veinAlpha", PUMP_SYM);
        result.fourXVeins = { veinShare: vs, linkMaxPx: lmax, linkMinPx: lmin, veinAlpha: va };
        if (num(vs) === null) missing("G2 veinShare($PUMP) 4×", "≤ 0.02", "veinShare"); else gate("G2 veinShare($PUMP) 4×", vs, "≤ 0.02", vs! <= 0.02, `linkMaxPx ${lmax}, linkMinPx ${lmin}`);
        if (num(lmax) === null) missing("G2 linkMaxPx 4×", "≤ 1.8", "linkMaxPx"); else gate("G2 linkMaxPx 4×", lmax, "≤ 1.8", lmax! <= 1.8);
        veinGates("4×", va);
        const fp = await p.evalJs<{ x: number; y: number; r: number } | null>(`__sporeMap.familyScreen(${J(pump)})`);
        const fk = await p.evalJs<{ x: number; y: number; r: number } | null>(`__sporeMap.familyScreen(${J(KIMCHI)})`).catch(() => null);
        const wp = whiteShare(imgB, fp, SC), wk = whiteShare(imgB, fk, SC);
        result.white4x = { pump: wp, kimchi: wk };
        gate("G2 white $PUMP 4×", wp?.share ?? null, "≤ 0.03", wp ? wp.share <= 0.03 : false, wp ? `${wp.px} px` : "no disc");
        gate("G2 white $Kimchi 4×", wk?.share ?? null, "≤ 0.03", wk ? wk.share <= 0.03 : null, wk ? `${wk.px} px` : "off screen at $PUMP 4× (checked at the overview)");
        // (repair) INTERACTION gates: hovering or selecting a big family's top must not bring the starburst / disc back
        // (the 23:21Z build lit every vein of the hovered brood at >= 0.8 linkA: Kimchi 4x hover rim ink 2.96, ring r60 97 % lit)
        if (!PHONE) {
          await p.evalJs(`__sporeMap.hover(${J(PUMP_SYM)})`); await sleep(900);
          const hvP = await call<Record<string, unknown>>(p, "veinAlpha", PUMP_SYM), hsP = vsOf(await call<unknown>(p, "veinShare", PUMP_SYM));
          result.hoverPump4x = { veinAlpha: hvP, veinShare: hsP };
          veinGates("4× hover", hvP); gate("G2 veinShare($PUMP) 4× hover", hsP, "≤ 0.02", num(hsP) !== null && hsP! <= 0.02);
          await p.evalJs(`__sporeMap.hover(null)`); await sleep(400);
          if (await p.evalJs<boolean>(`__sporeMap.zoomTo(${J(KIMCHI)}, 4)`)) {
            await settle(p, 2500);
            const nk = await call<{ x: number; y: number; r: number; onScreen: boolean }>(p, "nodePx", KIMCHI);
            await p.evalJs(`__sporeMap.hover(${J(KIMCHI)})`); await sleep(900);
            const hvK = await call<Record<string, unknown>>(p, "veinAlpha", "Kimchi"), hsK = vsOf(await call<unknown>(p, "veinShare", "Kimchi"));
            const imgH = await shot(p, "kimchi-4x-hover");
            const ring = nk ? ringLit(imgH, nk.x * SC, nk.y * SC, 60 * SC) : null;
            result.hoverKimchi4x = { veinAlpha: hvK, veinShare: hsK, node: nk, ringR60: ring };
            veinGates("Kimchi 4× hover", hvK); gate("G2 veinShare($Kimchi) 4× hover", hsK, "≤ 0.02", num(hsK) !== null && hsK! <= 0.02);
            gate("G2 ring r60 $Kimchi 4× hover", ring, "≤ 40 % lit (lum > 35 on the circle r = 60 px around the top)", ring !== null && ring <= 40);
            await p.evalJs(`__sporeMap.hover(null)`); await sleep(400);
            // selection through the page's own path (a click on the top): the selected subtree keeps its brood budget
            if (nk && nk.onScreen) {
              await p.hover(nk.x, nk.y); await sleep(200); await p.click(nk.x, nk.y); await sleep(1800);
              await p.hover(10, 450); await sleep(600);
              const sel = await p.evalJs<string | null>("__sporeMap.selected()");
              const svK = await call<Record<string, unknown>>(p, "veinAlpha", "Kimchi");
              const imgS = await shot(p, "kimchi-selected");
              const lum = lumShare(imgS, [345 * SC, 64 * SC, imgS.w - 60 * SC, imgS.h - 40 * SC], 40);
              result.selectKimchi = { selected: sel, veinAlpha: svK, mapLumGt40: lum };
              gate("G2 veinAlpha p50 $Kimchi selected", num((svK as { p50?: unknown } | null)?.p50), `≤ 0.10 (selected ${sel ? sel.slice(0, 8) : "none"})`, svK ? num((svK as { p50?: unknown }).p50) !== null && (svK as { p50: number }).p50 <= 0.1 : null);
              gate("G2 map-area lum>40 $Kimchi selected", lum, "≤ 15 % (the old build 10 %)", lum <= 15);
              await p.key("Escape"); await sleep(500);
            }
            // the overview hover: a quiet veil on the chip, never a solid disc (ring r25 around the 11 px chip)
            if (await p.evalJs<boolean>(`__sporeMap.zoomTo(${J(KIMCHI)}, 1)`)) {
              await settle(p, 2500);
              const nko = await call<{ x: number; y: number; r: number; onScreen: boolean }>(p, "nodePx", KIMCHI);
              await p.evalJs(`__sporeMap.hover(${J(KIMCHI)})`); await sleep(1200);
              const hvO = await call<Record<string, unknown>>(p, "veinAlpha", "Kimchi");
              const imgO = await shot(p, "kimchi-ov-hover");
              const ringO = nko ? ringLit(imgO, nko.x * SC, nko.y * SC, 25 * SC) : null;
              result.hoverKimchiOv = { veinAlpha: hvO, node: nko, ringR25: ringO };
              veinGates("Kimchi overview hover", hvO);
              gate("G2 ring r25 $Kimchi ov hover", ringO, "≤ 40 % lit", ringO !== null && ringO <= 40);
              await p.evalJs(`__sporeMap.hover(null)`); await sleep(400);
            }
            await p.evalJs(`__sporeMap.zoomTo(${J(pump)}, 4)`); await settle(p, 2500);
          }
        }
      }
      if (want("G5")) {
        const kv = await call<Record<string, unknown>>(p, "kidVis", PUMP_SYM);
        result.kidVis4x = kv;
        if (!kv) missing("G5 kidVis($PUMP) 4×", "≥ 0.95", "kidVis");
        else {
          gate("G5 kidVis($PUMP) 4×", kv.share, `≥ 0.95 (visible ${kv.visible}/${kv.inRect ?? kv.kids})`, num(kv.share) !== null && (kv.share as number) >= 0.95);
          gate("G5 kidVis p10Max 4×", kv.p10Max, "≥ 56", num(kv.p10Max) !== null && (kv.p10Max as number) >= 56);
          const names = ["live", "cooling", "quiet", "cold"], bh = Array.isArray(kv.byHeat) ? (kv.byHeat as { n: number; vis: number }[]) : null;
          if (!bh) missing("G5 kidVis byHeat 4×", "each ≥ 0.95", "kidVis.byHeat");
          else bh.forEach((h, j) => gate(`G5 kidVis ${names[j]} 4×`, h.n ? h.vis / h.n : null, `≥ 0.95 (${h.vis}/${h.n})`, h.n ? h.vis / h.n >= 0.95 : null, h.n ? undefined : "no coins in this class"));
        }
      }
      if (want("G1")) {
        // (fixer) at the integrated fit k0 no $PUMP child reaches 10 px at 4×: the children-logo gate runs at $PUMP 12×
        await p.evalJs(`__sporeMap.zoomTo(${J(pump)}, 12)`);
        await settle(p, 2500);
        await sleep(3000);
        const lc = await call<Record<string, number>>(p, "logoCoverage");
        result.logoCoverage12x = lc;
        if (!lc || num(lc.kids10WithImage) === null) missing("G1 kids ≥10px logo share 12×", "≥ 0.90", "logoCoverage.kids10Drawn/kids10WithImage");
        else if (!lc.kids10WithImage) gate("G1 kids ≥10px logo share 12×", `${lc.kids10Drawn}/${lc.kids10WithImage}`, "≥ 0.90", null, `no child ≥ 10 px with an image at $PUMP 12× (kids10 ${lc.kids10})`);
        else { const s = lc.kids10Drawn / lc.kids10WithImage; gate("G1 kids ≥10px logo share 12×", s, `≥ 0.90 (${lc.kids10Drawn}/${lc.kids10WithImage})`, s >= 0.9); }
      }
    }
    result.errors = p.errors.slice(0, 10); result.netErrors = p.netErrors.slice(0, 10);
    gate("console errors", p.errors.length, "== 0", p.errors.length === 0, p.errors[0]?.slice(0, 120));
  } finally { await p.close().catch(() => null); await br.close().catch(() => null); }
}

/// G4: Pokémon's drawn radius at the CARDS family 4×, on the sizing lane's fixture and on the baseline fixture
async function pokemonAt(url: string, label: string): Promise<{ r: number | null; largest: boolean; kids: number; maxKid: { mint: string; r: number } | null } | null> {
  const br = await launchChrome({ gpu: "metal", width: 1440, height: 900 });
  const p = await br.newPage({ width: 1440, height: 900, dpr: 1 });
  try {
    await p.navigate(url.replace(/\/$/, "") + withDebug("/map"), 60_000);
    await p.waitFor(mapReadyJs("three"), 120_000, "three map");
    await settle(p, 1500);
    if (!(await p.evalJs<boolean>(`__sporeMap.zoomTo(${J(CARDS)}, 4)`))) return null;
    await settle(p, 2500);
    await shot(p, `cards-4x-${label}`);
    const kids = await p.evalJs<string[]>(`__sporeMap.children(${J(CARDS)})`);
    let maxKid: { mint: string; r: number } | null = null, pr: number | null = null;
    for (const m of kids) {
      const n = await call<{ r: number }>(p, "nodePx", m);
      if (!n) return { r: null, largest: false, kids: kids.length, maxKid: null };
      if (m === POKEMON) pr = n.r;
      if (!maxKid || n.r > maxKid.r) maxKid = { mint: m, r: n.r };
    }
    return { r: pr, largest: !!maxKid && maxKid.mint === POKEMON, kids: kids.length, maxKid };
  } finally { await p.close().catch(() => null); await br.close().catch(() => null); }
}

/// C1: the coin page tree (classic renderer): every child at sr ≥ IMG_R whose logo loaded draws it within 5 s
async function coinPage() {
  const br = await launchChrome({ gpu: "metal", width: 1440, height: 900 });
  const p = await br.newPage({ width: 1440, height: 900, dpr: 1 });
  try {
    await p.navigate(`${BASE}/c/${BATON}?debug#tree`, 60_000);   // the Family tree tab (CoinActivity mirrors the hash)
    await p.waitFor("!!(window.__sporeRender && __sporeRender.firstPaintAt > 0)", 60_000, "coin tree paint").catch(() => null);
    const t0 = Date.now(), series: unknown[] = [];
    let last: { want: number; loaded: number; drawn: number } | null = null;
    while (Date.now() - t0 <= 5000) {
      last = await p.evalJs(`(() => { const r = window.__sporeRender; return r ? { want: r.logoWant, loaded: r.logoLoaded, drawn: r.logoDrawn, nodes: r.drawn } : null; })()`);
      series.push({ t: Date.now() - t0, ...last });
      await sleep(500);
    }
    await shot(p, "coin-baton");
    result.coinPage = { series, last, errors: p.errors.slice(0, 5) };
    if (!last || last.want === undefined) missing("C1 coin page logos (Baton)", "drawn == loaded within 5 s", "__sporeRender.logoWant");
    else gate("C1 coin page logos (Baton)", last, `drawn == loaded within 5 s (want ${last.want} = children at sr ≥ 6 with an image)`, last.want > 0 && last.drawn >= last.loaded && last.loaded === last.want);
  } finally { await p.close().catch(() => null); await br.close().catch(() => null); }
}

try {
  if ([...ONLY].some((g) => g.startsWith("G")) || !ONLY.size) await mainRun();
  if (want("G4") && !PHONE) {
    if (!SIZE_URL || !BASE_URL) gate("G4 Pokémon in CARDS", null, "largest child, ≥ 2× fixture", null, "skipped: --size-url and --base-url (S/size-fixture, S/mapThree) not both given");
    else {
      const a = await pokemonAt(SIZE_URL, "size"), b = await pokemonAt(BASE_URL, "base");
      result.pokemon = { size: a, base: b };
      if (!a || a.r === null) missing("G4 Pokémon in CARDS", "largest child, ≥ 2× fixture", a ? "nodePx" : "CARDS not on the size fixture");
      else {
        gate("G4 Pokémon largest CARDS child", a.maxKid, "Pokémon", a.largest, `${a.kids} children`);
        const ratio = b?.r ? a.r / b.r : null;
        gate("G4 Pokémon r size/base", ratio, `≥ 2 (r ${a.r?.toFixed(2)} vs ${b?.r?.toFixed(2)})`, ratio !== null && ratio >= 2);
      }
    }
  }
  if (COIN && !PHONE) await coinPage();
} catch (e) { result.fatal = String((e as Error).stack || e); console.log("FATAL", result.fatal); }

result.rows = rows;
const fails = rows.filter((r) => r.pass === false);
result.verdict = fails.length || result.fatal ? `FAIL (${fails.length}${result.fatal ? " + fatal" : ""})` : "PASS";
writeFileSync(join(OUT, `flat-gates-${TAG}.json`), JSON.stringify(result, null, 1));
let all: Record<string, unknown> = {};
try { if (existsSync(JSON_OUT)) all = JSON.parse(readFileSync(JSON_OUT, "utf8")); } catch { all = {}; }
all[TAG] = { url: BASE, at: result.at, verdict: result.verdict, rows };
mkdirSync(join(JSON_OUT, ".."), { recursive: true });
writeFileSync(JSON_OUT, JSON.stringify(all, null, 1));
console.log(`${result.verdict} · ${rows.length} rows · ${join(OUT, `flat-gates-${TAG}.json`)} · ${JSON_OUT}[${TAG}]`);
if (fails.length || result.fatal) process.exitCode = 1;
