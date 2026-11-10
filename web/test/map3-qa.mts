// map3 QA (map3 spec 13.3): the Three.js renderer of /map, end to end through Chrome's DevTools protocol
// (test/map3-cdp.mts), against a local production build behind test/serve-prod.mts (live upstream data,
// the page's EventSource mocked so events are dispatched by the script). Sections:
//   (a) renderer + chunk: renderer() three, .m3-canvas holds WebGL2, no .bm-canvas; no map3 chunk on "/" or
//       /c/<mint>; on /map exactly 1 EventSource, no request to /api/events, exactly 1 full /api/map request
//       on a cold load, no /api/coin request before a selection; the main chunk has no "WebGLRenderer"
//   (b) overview: zoom() 0.97–1.03 settled, titles() ≥ 20 at 1440×900, labelStats overlaps 0, labelHud 0 and
//       foreignColony 0 (no planet label or callout on, no leader across, another family's colony; 390×844 in k)
//   (c) click flow: a planet chip → ?focus=<top> within 2 s, .map-side, selected() = top, ≥ 80 % of the
//       members inside the inset rect; a child drawn ≥ 6 px → ?focus=<child>; empty space → no ?focus
//   (d) page → map: a Rails row → selected() + a flight; ↓ / → walk the tree; "0" → zoom() < 1.05; "+" → ×1.5 ± 10 %
//   (e) hover: a real mouse over a coin → .m3-tip.on with "Market cap"; over the selected coin → no tooltip;
//       a side-panel kid row → hovered() is that kid
//   (f) size: market cap only (no size param, no .bm-size control); the top-5 planet tags equal
//       __sporeMapPage.dominance().mcap (sharePct); still no control and no size param after a reload
//   (g) highlight: ?hl=ours → hl() = 1 exactly for hlCounts().ours coins
//   (h) live (MockES): trade → fx() > 0 within 300 ms + lastTrade advanced; pair → has() within 1 s, nodes() + 1,
//       builds() unchanged, a "new ·" toast; 300 trades in 5 s → rAF p95 ≤ 17.5 ms, 0 long tasks; mapdelta →
//       node().mcapUsd updated, builds() unchanged
//   (i) heat (Fetch intercept): 3 rows → lastTrade > 0 for them; a 404 → no console output, the map renders
//   (j) drag: dragCoin(top of the biggest family) at the overview → coinsOffHome 0, held p95 ≤ 17.5, intrusion 0;
//       a real mouse drag of a chip by 200 px → drag().n = 1 while held, allXY identical 2 s after the rest
//   (k) phone 390×844 DPR 2 touch: top-5 families on screen, labels clean; a tap → .m3-tip.dock.on above the
//       bottom inset, the tapped chip not under the card, the +/- column hidden while it is up; "Open family" → ?focus, .map-sheet.peek, the coin between overlay and sheet, no
//       horizontal overflow; long-press 320 ms + 80 px → drag() while held
//   (l) reduced motion (--force-prefers-reduced-motion, then localStorage spore:motion=paused): 0 renders over
//       5 s idle, a trade leaves fx() at 0
//   (m) fallback: --disable-gpu → classic / no-webgl2 with .bm-canvas and 0 console errors; ?renderer=classic →
//       classic / param; ?m3fail → classic / mount-error, 0 console errors (warn allowed), and not remembered;
//       kill switch (/map-renderer.json intercepted as {"renderer":"classic"}) → classic / off, and the next visit
//       with the real file (three) → three again after one visit; three WebGL context losses → classic /
//       context-lost, the next visit → classic / sticky, ?renderer=three → three and the record cleared
//   (n) leak: 5 SPA cycles /map → / → /map: counters().live 0 after each, heap growth cycle 1 → 5 ≤ 8 MB after GC,
//       DOM nodes + JS listeners within 5 % of cycle 1, no "Too many active WebGL contexts", the map works after
//   (o) other pages: /c/<mint>#tree and /embed/map render .bm-canvas, no map3 chunk; screenshots
//   (p) 0 console errors overall (network errors listed separately)
//
//   node --import tsx test/map3-qa.mts --url http://127.0.0.1:5260 --prod --shots <dir> [--only a,b,c] [--chrome-gpu metal|swiftshader]
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INSET_RECT_JS, LOOK, MAP3_ASSET_RE, MOCK_ES, RAF_PROBE, SETTLED_JS, cli, launchChrome, map3AssetsJs, mapReadyJs, rafStatsJs, sleep, withDebug,
  type Browser, type GpuMode, type Page, type RafStats,
} from "./map3-cdp.mts";
import { sharePct } from "../src/lib/map/dominance.ts";

const { opt, has } = cli();
const BASE = opt("--url", "http://127.0.0.1:5260")!.replace(/\/$/, "");
const PROD = has("--prod");
const ONLY = opt("--only");
const SHOTS = opt("--shots", join(process.env.SPORE_TMP ?? tmpdir(), "spore-map3-qa"))!;
const GPU = (opt("--chrome-gpu", "metal") ?? "metal") as GpuMode;
const W = 1440, H = 900;
mkdirSync(SHOTS, { recursive: true });
const J = JSON.stringify;
const u = (path: string) => withDebug(path, PROD);
const want = (k: string) => !ONLY || ONLY.split(",").map((s) => s.trim()).includes(k);
const result: Record<string, unknown> = { url: BASE, prod: PROD, gpu: GPU, startedAt: new Date().toISOString() };
const sections: Record<string, Record<string, unknown>> = {};
const fails: string[] = [];
const notes: string[] = [];
const pages: Page[] = [];
const browsers: Browser[] = [];

/// Page-side helpers (installed on every document): hit-tested points on the canvas, the inset rect.
/// renderer()/fallback() as page expressions; a pre-map3 build (no renderer()) reads as classic / "n/a".
const RENDERER_JS = `(window.__sporeMapPage && typeof __sporeMapPage.renderer === "function" ? __sporeMapPage.renderer() : "classic")`;
const FALLBACK_JS = `(window.__sporeMapPage && typeof __sporeMapPage.fallback === "function" ? __sporeMapPage.fallback() : "n/a")`;

const QA_HELPERS = `(() => {
  const qa = window.__qa = {};
  qa.onCanvas = (x, y) => { const el = document.elementFromPoint(x, y); return !!el && el.classList.contains("m3-canvas"); };
  qa.insetRect = () => ${INSET_RECT_JS};
  qa.inRect = (p, R, pad = 0) => !!p && !!R && p.x >= R.x0 + pad && p.x <= R.x1 - pad && p.y >= R.y0 + pad && p.y <= R.y1 - pad;
  qa.inView = (p, pad = 0) => !!p && p.x >= pad && p.y >= pad && p.x <= innerWidth - pad && p.y <= innerHeight - pad;
  qa.pointOn = (mint, cluster, R) => {
    const M = window.__sporeMap; if (!M) return null;
    const cands = [], s = M.screenOf(mint);
    if (s) { cands.push([s.x, s.y]); const r = Math.max(1, s.r) * 0.45; for (let a = 0; a < 8; a++) cands.push([s.x + Math.cos(a * 0.785398) * r, s.y + Math.sin(a * 0.785398) * r]); }
    if (cluster) { const f = M.familyScreen(mint); if (f) { cands.push([f.x, f.y]); for (let ring = 1; ring <= 4; ring++) for (let a = 0; a < 12; a++) { const rr = f.r * ring / 6; cands.push([f.x + Math.cos(a * 0.5236) * rr, f.y + Math.sin(a * 0.5236) * rr]); } } }
    for (const [x, y] of cands) {
      if (!qa.inView({ x, y }, 2) || (R && !qa.inRect({ x, y }, R, 2)) || !qa.onCanvas(x, y)) continue;
      const p = M.pick(x, y);
      if (cluster ? p.cluster === mint : p.node === mint) return { x, y, r: s ? s.r : 0, via: p.via };
    }
    return null;
  };
  qa.emptyPoint = (R) => {
    const M = window.__sporeMap; if (!M || !R) return null;
    const none = (x, y) => qa.onCanvas(x, y) && M.pick(x, y).via === "none";
    const cx = (R.x0 + R.x1) / 2, cy = (R.y0 + R.y1) / 2, pts = [];
    for (let y = R.y0 + 14; y < R.y1 - 14; y += 19) for (let x = R.x0 + 14; x < R.x1 - 14; x += 19) pts.push([x, y, Math.hypot(x - cx, y - cy)]);
    pts.sort((a, b) => a[2] - b[2]);
    for (const [x, y] of pts) if (none(x, y) && none(x + 8, y) && none(x - 8, y) && none(x, y + 8) && none(x, y - 8)) return { x, y };
    return null;
  };
  qa.param = (n) => new URLSearchParams(location.search).get(n);
  qa.rect = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
  qa.visible = (sel) => { const r = qa.rect(sel); return !!r && r.w > 0 && r.h > 0; };
})();`;

// ---------------------------------------------------------------- truth from the API (through serve-prod)
type Coin = { mint: string; symbol: string | null; name: string | null; depth: number; mcapUsd: number | null; lockedUsd: number | null; children: number; descendants?: number; ours?: boolean; asset?: boolean; createdAt?: number | null; image?: string | null; migrated?: boolean };
type TNode = { coin: Coin; children: TNode[] };
type Row = Coin & { parentMint: string | null; top: string };
async function loadTruth(): Promise<Row[]> {
  const j = (await fetch(`${BASE}/api/map?scope=all&limit=all`).then((r) => r.json())) as { roots: TNode[] };
  const out: Row[] = [];
  const walk = (n: TNode, p: string | null, top: string) => { out.push({ ...n.coin, parentMint: p, top }); for (const k of n.children) walk(k, n.coin.mint, top); };
  for (const r of j.roots) walk(r, null, r.coin.mint);
  return out;
}

// ---------------------------------------------------------------- helpers
const section = async (key: string, fn: (s: Record<string, unknown>, check: (c: boolean, m: string) => boolean) => Promise<void>) => {
  if (!want(key)) return;
  const s: Record<string, unknown> = {};
  const mine: string[] = [];
  const check = (c: boolean, m: string) => { if (!c) { mine.push(m); fails.push(`(${key}) ${m}`); } return c; };
  const t0 = Date.now();
  try { await fn(s, check); } catch (e) { check(false, `crashed: ${(e as Error).message}`); }
  s.ms = Date.now() - t0;
  s.ok = mine.length === 0;
  if (mine.length) s.failures = mine;
  sections[key] = s;
  console.error(`(${key}) ${mine.length ? `FAIL ${mine.length}` : "ok"} in ${s.ms} ms${mine.length ? `: ${mine.join(" | ")}` : ""}`);
};
async function openMap(p: Page, path = "/map", renderer: "three" | "classic" = "three", timeoutMs = 120_000) {
  await p.navigate(BASE + u(path), 60_000);
  await p.waitFor(mapReadyJs(renderer), timeoutMs, `${renderer} map on ${path}`);
}
const spa = (p: Page, path: string) => p.evalJs(`(history.pushState({}, "", ${J(u(path))}), dispatchEvent(new PopStateEvent("popstate")), true)`);
async function settle(p: Page, ms = 30_000, what = "the map to settle") {
  await p.waitFor(SETTLED_JS, ms, what).catch(() => notes.push(`settle timeout: ${what}`));
  await sleep(300);
}
const param = (p: Page, n: string) => p.evalJs<string | null>(`new URLSearchParams(location.search).get(${J(n)})`);
const shot = (p: Page, name: string) => p.shot(join(SHOTS, name)).catch((e) => `shot failed: ${(e as Error).message}`);
/// On /map (three) at the overview with no selection, no highlight and the locked size.
async function toOverview(p: Page) {
  const st = await p.evalJs<{ on: boolean; q: string }>(`({ on: !!(window.__sporeMapPage && __sporeMapPage.renderer && __sporeMapPage.renderer() === "three" && window.__sporeMap && location.pathname === "/map"), q: location.search })`).catch(() => ({ on: false, q: "" }));
  if (!st.on) await openMap(p, "/map");
  else if (/focus=|hl=|size=|roots=/.test(st.q)) { await spa(p, "/map"); await sleep(1200); }
  await p.waitFor(mapReadyJs("three"), 60_000, "the map");
  await p.mouse("mouseMoved", 3, 3);
  await p.evalJs("__sporeMap.fit()");
  await sleep(250);
  await settle(p);
}
const consoleMark = (p: Page) => p.logs.length;
const consoleSince = (p: Page, mark: number) => p.logs.slice(mark).filter((l) => /^(error|warning|assert): /.test(l));

async function mainChunk(): Promise<Record<string, unknown>> {
  const html = await fetch(`${BASE}/`).then((r) => r.text());
  const src = /<script[^>]+src="(\/assets\/index-[^"]+\.js)"/.exec(html)?.[1];
  if (!src) return { error: "no /assets/index-*.js in index.html" };
  const js = await fetch(BASE + src).then((r) => r.text());
  return { src, bytes: js.length, webglRenderer: js.includes("WebGLRenderer") };
}

// ---------------------------------------------------------------- run
let truth: Row[] = [];
try {
  truth = await loadTruth();
  result.truth = { coins: truth.length, roots: truth.filter((r) => !r.parentMint).length };
  const famSize = new Map<string, number>();
  for (const r of truth) famSize.set(r.top, (famSize.get(r.top) ?? 0) + 1);
  // the coin page subject: the non-asset root with the most coins under it
  const coinRoot = truth.filter((r) => !r.parentMint && !r.asset).sort((a, b) => (famSize.get(b.mint) ?? 0) - (famSize.get(a.mint) ?? 0))[0];
  if (!coinRoot) throw new Error("no root coin in /api/map");
  result.coinPage = { mint: coinRoot.mint, symbol: coinRoot.symbol, family: famSize.get(coinRoot.mint) };

  const browser = await launchChrome({ gpu: GPU, width: W, height: H });
  browsers.push(browser);
  const page = await browser.newPage({ prelude: [MOCK_ES, RAF_PROBE, QA_HELPERS] });
  pages.push(page);

  // ---------------------------------------------------------------- (a)
  await section("a", async (s, check) => {
    await page.navigate(BASE + u("/"));
    await page.waitFor(`!!document.querySelector("#root") && document.querySelector("#root").children.length > 0`, 30_000, "home page");
    await sleep(3000);
    const homeAssets = await page.evalJs<string[]>(map3AssetsJs);
    await page.navigate(BASE + u(`/c/${coinRoot.mint}`));
    await page.waitFor(`document.body && document.body.innerText.length > 300`, 30_000, "coin page");
    await sleep(3000);
    const coinAssets = await page.evalJs<string[]>(map3AssetsJs);
    s.homeAssets = homeAssets; s.coinAssets = coinAssets;
    check(homeAssets.length === 0, `"/" loaded the map3 chunk: ${homeAssets.join(", ")}`);
    check(coinAssets.length === 0, `/c/<mint> loaded the map3 chunk: ${coinAssets.join(", ")}`);
    // cold /map: drop the map cache first (same origin)
    s.idbClear = await page.evalJs<string>(`new Promise((res) => { const r = indexedDB.deleteDatabase("spore-map"); r.onsuccess = () => res("ok"); r.onerror = () => res("error"); r.onblocked = () => setTimeout(() => res("blocked"), 3000); })`);
    const reqMark = page.requests.length;
    await openMap(page, "/map");
    const esAtPaint = await page.evalJs<number>("(window.__es || []).length");
    await settle(page);
    await sleep(3000);
    const r = await page.evalJs<{ renderer: string; fallback: string | null; gl: string; bm: boolean; es: number; esOpen: number; maps: string[]; chunk: string[]; engine: Record<string, unknown> | null; selected: string | null }>(`({
      renderer: ${RENDERER_JS}, fallback: ${FALLBACK_JS},
      gl: (() => { const c = document.querySelector(".m3-canvas"); if (!c) return "no .m3-canvas"; const g = c.getContext("webgl2"); return g ? (g.isContextLost() ? "lost" : "webgl2") : "no webgl2 context"; })(),
      bm: !!document.querySelector(".bm-canvas"), es: (window.__es || []).length, esOpen: (window.__es || []).filter((e) => e.readyState !== 2).length,
      maps: performance.getEntriesByType("resource").map((e) => e.name).filter((n) => /\\/api\\/map(\\?|$)/.test(n)).map((n) => n.replace(/^.*\\/api\\/map/, "/api/map")),
      chunk: ${map3AssetsJs}, engine: __sporeMap.engine(), selected: __sporeMap.selected() })`);
    const reqs = page.requests.slice(reqMark);
    const evReq = reqs.filter((q) => /\/api\/events/.test(q.url)).map((q) => `${q.type} ${q.url}`);
    const coinReq = reqs.filter((q) => /\/api\/coin\//.test(q.url)).map((q) => q.url);
    const full = r.maps.filter((m) => !/[?&]since=/.test(m));
    Object.assign(s, { renderer: r.renderer, fallback: r.fallback, gl: r.gl, bmCanvas: r.bm, eventSources: r.es, eventSourcesOpen: r.esOpen, mapRequests: r.maps, eventsRequests: evReq, coinRequests: coinReq, chunkOnMap: r.chunk, engine: r.engine });
    check(r.renderer === "three", `renderer() is ${r.renderer}`);
    check(r.gl === "webgl2", `.m3-canvas: ${r.gl}`);
    check(!r.bm, ".bm-canvas present under three");
    s.eventSourcesAtFirstPaint = esAtPaint;
    // a dev server runs React StrictMode, whose double mount of the Shell opens and closes one extra stream before the map
    check(r.esOpen === 1 && r.es === esAtPaint && (!PROD || r.es === 1), `EventSources on /map: ${r.es} created (${esAtPaint} at first paint), ${r.esOpen} open (expected 1 open, none created by the map${PROD ? ", 1 in all" : ""})`);
    check(evReq.length === 0, `requests to /api/events (expected none, the stream is mocked): ${evReq.join(", ")}`);
    check(full.length === 1, `full /api/map requests on a cold load: ${full.length} (${r.maps.join(", ")})`);
    check(r.selected === null && coinReq.length === 0, `/api/coin requested before a selection: ${coinReq.slice(0, 3).join(", ")}`);
    check(r.chunk.length > 0, `no resource on /map matched ${MAP3_ASSET_RE} (the chunk-name checks on "/" and /c would prove nothing)`);
    if (PROD) { const mc = await mainChunk(); s.mainChunk = mc; check(mc.webglRenderer === false, `main chunk: ${J(mc)}`); }
    else s.mainChunk = "dev server: no bundle to inspect (run with --prod against a build)";
    s.shot = await shot(page, "a-map-cold.png");
  });

  // ---------------------------------------------------------------- (b)
  await section("b", async (s, check) => {
    await toOverview(page);
    const r = await page.evalJs<{ k: number; titles: number; tagged: number; labels: Record<string, number> | null; vw: number; vh: number }>(`({ k: __sporeMap.zoom(), titles: __sporeMap.titles().length, tagged: __sporeMap.taggedTitles().length, labels: __sporeMap.labelStats(), vw: innerWidth, vh: innerHeight })`);
    Object.assign(s, r);
    check(r.k >= 0.97 && r.k <= 1.03, `zoom() at the overview ${r.k.toFixed(3)} (0.97–1.03)`);
    check(r.titles >= 20, `titles() ${r.titles} at ${r.vw}×${r.vh} (need ≥ 20)`);
    check(!!r.labels && r.labels.overlaps === 0, `labelStats().overlaps ${r.labels?.overlaps} at ${r.vw}×${r.vh}`);
    check(!!r.labels && r.labels.labelHud === 0, `labelStats().labelHud ${r.labels?.labelHud} at ${r.vw}×${r.vh}`);
    check(!!r.labels && r.labels.foreignColony === 0, `labelStats().foreignColony ${r.labels?.foreignColony} at ${r.vw}×${r.vh}`);
    // galaxy spec §8 G-D: planet title format per look. galaxy: line 2 "N · share%" (tagged) or "N coins"; flat: today's
    // "<tag> · N coins" / "N coins". The look is read from the page (SPA navigations carry no ?look).
    const tf = await page.evalJs<{ look: string | null; lines: string[] }>(`(() => ({ look: typeof __sporeMap.look === "function" ? __sporeMap.look() : null, lines: [...document.querySelectorAll(".m3 .m3-labels .lb.pl")].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && Number(getComputedStyle(e).opacity) > 0.05; }).map((e) => (e.innerText || e.textContent || "").split("\\n").map((x) => x.trim()).filter(Boolean)).filter((ls) => ls.length >= 2).map((ls) => ls[ls.length - 1]) }))()`);
    s.look = tf.look; s.titleLines = tf.lines.slice(0, 8);
    if (LOOK) check(tf.look === LOOK || (LOOK === "flat" && tf.look === null), `--look ${LOOK} but __sporeMap.look() is ${J(tf.look)}`);
    const titleRe = tf.look === "galaxy" ? /^(\d[\d,.]*k? · .+%|\d[\d,.]*k? coins)$/ : /(^|\s)\d[\d,.]*k? coins$/;   // (family-all) true sizes of 10k+ read "51.8k coins"
    const badTitles = tf.lines.filter((l) => !titleRe.test(l));
    check(tf.lines.length > 0 && badTitles.length === 0, `planet titles not in the ${tf.look ?? "flat"} format ${titleRe}: ${J(badTitles.slice(0, 4))}`);
    s.shot = await shot(page, "b-overview-1440.png");
  });

  // ---------------------------------------------------------------- (c)
  await section("c", async (s, check) => {
    await toOverview(page);
    const top = (await page.evalJs<{ root: string; count: number; title: string }[]>("__sporeMap.clusters(1)"))[0];
    if (!check(!!top, "no family")) return;
    s.family = top;
    const pt = await page.evalJs<{ x: number; y: number; via: string } | null>(`__qa.pointOn(${J(top.root)}, true, __qa.insetRect())`);
    if (!check(!!pt, "no point on the canvas hands the pointer to the largest family")) return;
    s.chipPoint = pt;
    const t0 = Date.now();
    await page.click(pt!.x, pt!.y);
    const ok = await page.waitFor(`new URLSearchParams(location.search).get("focus") === ${J(top.root)}`, 2000, "?focus=<top>", 25).then(() => true, () => false);
    s.focusMs = Date.now() - t0;
    check(ok, `clicking the planet chip did not set ?focus=<top> within 2 s (focus ${await param(page, "focus")})`);
    check(await page.waitFor(`__qa.visible(".map-side")`, 3000, ".map-side").then(() => true, () => false), ".map-side is not visible after the click");
    await page.waitFor("!__sporeMap.flying()", 5000, "the flight").catch(() => null);
    await settle(page);
    const v = await page.evalJs<{ on: number; total: number; selected: string | null; k: number; R: unknown }>(`(() => { const M = __sporeMap, R = __qa.insetRect(), ms = M.members(${J(top.root)}); let on = 0; for (const m of ms) if (__qa.inRect(M.screenOf(m), R)) on++; return { on, total: ms.length, selected: M.selected(), k: M.zoom(), R }; })()`);
    s.framed = v;
    check(v.selected === top.root, `selected() ${v.selected} after the chip click, expected ${top.root}`);
    check(v.total > 0 && v.on / v.total >= 0.8, `only ${v.on}/${v.total} members inside the inset rect`);
    s.shotFamily = await shot(page, "c-family.png");
    // a child drawn ≥ 6 px (zoom in on the top when the family framing draws them smaller)
    const findChild = () => page.evalJs<{ mint: string; x: number; y: number; r: number } | null>(`(() => { const M = __sporeMap, R = __qa.insetRect(); const kids = M.children(${J(top.root)}).map((m) => ({ m, s: M.screenOf(m) })).filter((k) => k.s && k.s.r >= 6 && __qa.inRect(k.s, R, k.s.r)).sort((a, b) => b.s.r - a.s.r); for (const k of kids) { const p = __qa.pointOn(k.m, false, R); if (p) return { mint: k.m, x: p.x, y: p.y, r: k.s.r }; } return null; })()`);
    let child = await findChild();
    for (let z = 0; !child && z < 3; z++) {
      await page.evalJs(`__sporeMap.zoomTo(${J(top.root)}, __sporeMap.zoom() * 2)`);
      await sleep(400); await settle(page);
      child = await findChild();
    }
    if (check(!!child, "no child of the family drawn ≥ 6 px inside the inset rect")) {
      s.child = child;
      await page.click(child!.x, child!.y);
      check(await page.waitFor(`new URLSearchParams(location.search).get("focus") === ${J(child!.mint)}`, 2000, "?focus=<child>", 25).then(() => true, () => false), `clicking the child did not set ?focus=<child> (focus ${await param(page, "focus")})`);
      await settle(page);
    }
    // empty space clears the selection
    const empty = await page.evalJs<{ x: number; y: number } | null>("__qa.emptyPoint(__qa.insetRect())");
    if (check(!!empty, "no empty point inside the inset rect")) {
      s.empty = empty;
      await page.click(empty!.x, empty!.y);
      check(await page.waitFor(`!new URLSearchParams(location.search).has("focus")`, 2000, "no ?focus", 25).then(() => true, () => false), `clicking empty space did not clear ?focus (${await param(page, "focus")})`);
    }
  });

  // ---------------------------------------------------------------- (d)
  await section("d", async (s, check) => {
    await toOverview(page);
    const rowJs = `(() => { const rows = [...document.querySelectorAll(".map-rails .map-rail-row:not(.dom)")].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight; }); const b = rows[0]; if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: b.textContent.trim().slice(0, 40), rows: rows.length }; })()`;
    let row = await page.evalJs<{ x: number; y: number; text: string; rows: number } | null>(rowJs);
    if (!row) { // the dominance tab may be open: switch to the first other tab
      await page.evalJs(`(() => { const b = [...document.querySelectorAll(".map-rail-tabs button")].find((x) => !/dominance/i.test(x.textContent)); if (b) b.click(); return !!b; })()`);
      await sleep(400);
      row = await page.evalJs(rowJs);
    }
    if (check(!!row, "no visible Rails row")) {
      s.row = row;
      await page.evalJs(`(() => { const o = window.__flyObs = { any: false, stop: false, k0: __sporeMap.zoom(), c0: __sporeMap.camera() }; const loop = () => { if (__sporeMap.flying()) o.any = true; if (!o.stop) requestAnimationFrame(loop); }; requestAnimationFrame(loop); return true; })()`);
      await page.click(row!.x, row!.y);
      const f = await page.waitFor<string>(`new URLSearchParams(location.search).get("focus")`, 3000, "?focus from the Rails row").catch(() => null);
      if (check(!!f, "the Rails row did not set ?focus")) {
        const sel = await page.waitFor(`__sporeMap.selected() === ${J(f)}`, 10_000, "selected() = the row's coin").then(() => true, () => false);
        await sleep(1500);
        const fl = await page.evalJs<{ any: boolean; k0: number; k1: number; moved: number }>(`(() => { const o = window.__flyObs; o.stop = true; const c = __sporeMap.camera(); return { any: o.any, k0: o.k0, k1: __sporeMap.zoom(), moved: Math.hypot(c.x - o.c0.x, c.y - o.c0.y) * c.k }; })()`);
        s.rowPick = { focus: f, selected: sel, ...fl };
        check(sel, `selected() did not follow the Rails pick (${await page.evalJs("__sporeMap.selected()")} vs ${f})`);
        check(fl.any || Math.abs(fl.k1 / fl.k0 - 1) > 0.02 || fl.moved > 20, `no flight after the Rails pick (${J(fl)})`);
      }
    }
    // ↓ / → walk the tree from the biggest family's top
    const top = (await page.evalJs<{ root: string }[]>("__sporeMap.clusters(1)"))[0]?.root;
    await spa(page, `/map?focus=${top}`);
    await page.waitFor(`__sporeMap.selected() === ${J(top)}`, 8000, "selected() = top").catch(() => check(false, "?focus=<top> did not select the top"));
    await page.waitFor("!__sporeMap.flying()", 5000, "flight").catch(() => null);
    await page.evalJs("(document.activeElement && document.activeElement.blur && document.activeElement.blur(), true)");
    await page.key("ArrowDown");
    const f1 = await page.waitFor<string>(`(() => { const f = new URLSearchParams(location.search).get("focus"); return f && f !== ${J(top)} ? f : null; })()`, 2000, "↓").catch(() => null);
    const p1 = f1 ? await page.evalJs<string | null>(`(__sporeMap.node(${J(f1)}) || {}).parentMint || null`) : null;
    check(!!f1 && p1 === top, `↓ did not select a child of the top (focus ${f1}, parent ${p1})`);
    if (f1) check(await page.waitFor(`__sporeMap.selected() === ${J(f1)}`, 3000, "selected() after ↓").then(() => true, () => false), "selected() did not follow ↓");
    await page.key("ArrowRight");
    const f2 = f1 ? await page.waitFor<string>(`(() => { const f = new URLSearchParams(location.search).get("focus"); return f && f !== ${J(f1)} ? f : null; })()`, 2000, "→").catch(() => null) : null;
    const p2 = f2 ? await page.evalJs<string | null>(`(__sporeMap.node(${J(f2)}) || {}).parentMint || null`) : null;
    check(!!f2 && p2 === top, `→ did not move to a sibling (focus ${f2}, parent ${p2})`);
    if (f2) check(await page.waitFor(`__sporeMap.selected() === ${J(f2)}`, 3000, "selected() after →").then(() => true, () => false), "selected() did not follow →");
    s.walk = { top, down: f1, right: f2 };
    await page.waitFor("!__sporeMap.flying()", 5000, "flight").catch(() => null);
    await page.key("0");
    await sleep(200);
    await page.waitFor(SETTLED_JS, 6000, "the fit").catch(() => null);
    const kFit = await page.evalJs<number>("__sporeMap.zoom()");
    check(kFit < 1.05, `"0" left zoom() at ${kFit.toFixed(3)} (need < 1.05)`);
    await sleep(300);
    const z0 = await page.evalJs<number>("__sporeMap.zoom()");
    await page.key("+");
    await sleep(200);
    await page.waitFor(SETTLED_JS, 4000, "the zoom tween").catch(() => null);
    const z1 = await page.evalJs<number>("__sporeMap.zoom()");
    s.keys = { kFit, z0, z1, ratio: Math.round((z1 / z0) * 1000) / 1000 };
    check(z1 / z0 >= 1.35 && z1 / z0 <= 1.65, `"+" zoomed ×${(z1 / z0).toFixed(3)} (expected 1.5 ± 10 %)`);
    await page.key("Escape");
  });

  // ---------------------------------------------------------------- (e)
  await section("e", async (s, check) => {
    await toOverview(page);
    const target = await page.evalJs<{ mint: string; x: number; y: number; r: number } | null>(`(() => { const M = __sporeMap, R = __qa.insetRect(); for (const c of M.clusters(60)) { const sc = M.screenOf(c.root); if (!sc || sc.r < 6) continue; const p = __qa.pointOn(c.root, false, R); if (p) return { mint: c.root, x: p.x, y: p.y, r: sc.r }; } return null; })()`);
    if (!check(!!target, "no coin ≥ 6 px to hover at the overview")) return;
    s.target = target;
    await page.hover(target!.x, target!.y);
    const tipText = await page.waitFor<string>(`(() => { const t = document.querySelector(".m3 .m3-tip.on"); return t && t.textContent.includes("Market cap") ? t.textContent : null; })()`, 2500, "the tooltip").catch(() => null);
    const tip = await page.evalJs<{ on: boolean; mint: string | null } | null>("__sporeMap.tip()");
    s.tip = { ...tip, text: tipText?.slice(0, 160) ?? null };
    check(!!tipText, "a real mouse over a coin did not show .m3-tip.on with \"Market cap\"");
    check(!!tip && tip.mint === target!.mint, `tip() is for ${tip?.mint}, the pointer is over ${target!.mint}`);
    s.shotHover = await shot(page, "e-hover.png");
    // the selected coin shows no tooltip
    await page.click(target!.x, target!.y);
    await page.waitFor(`new URLSearchParams(location.search).get("focus") === ${J(target!.mint)}`, 3000, "?focus").catch(() => null);
    await page.waitFor("!__sporeMap.flying()", 5000, "flight").catch(() => null);
    await settle(page);
    const selPt = await page.evalJs<{ x: number; y: number } | null>(`__qa.pointOn(${J(target!.mint)}, false, __qa.insetRect())`);
    if (check(!!selPt, "the selected coin is not under any point of the canvas after the flight")) {
      await page.mouse("mouseMoved", selPt!.x - 60, selPt!.y + 40);
      await sleep(100);
      await page.hover(selPt!.x, selPt!.y);
      await sleep(900);
      const t2 = await page.evalJs<{ on: boolean; tip: unknown; sel: string | null }>(`({ on: !!document.querySelector(".m3 .m3-tip.on"), tip: __sporeMap.tip(), sel: __sporeMap.selected() })`);
      s.selectedHover = t2;
      check(!t2.on, `hovering the selected coin shows a tooltip (${J(t2.tip)})`);
      s.shotSelectedHover = await shot(page, "e-selected-hover.png");
    }
    // a side-panel kid row → hovered()
    const kid = await page.evalJs<{ x: number; y: number; title: string } | null>(`(() => { const b = [...document.querySelectorAll(".map-side .map-kid")].find((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.top >= 0 && r.bottom <= innerHeight; }); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, title: b.getAttribute("title") || "" }; })()`);
    if (check(!!kid, "no visible kid row in the side panel")) {
      await page.hover(kid!.x, kid!.y);
      const hv = await page.waitFor<string>(`(() => { const h = __sporeMap.hovered(); return h && __sporeMap.children(${J(target!.mint)}).includes(h) ? h : null; })()`, 2000, "hovered() = a kid").catch(() => null);
      const n = hv ? await page.evalJs<{ name: string | null; symbol: string | null }>(`(() => { const n = __sporeMap.node(${J(hv)}) || {}; return { name: n.name || null, symbol: n.symbol || null }; })()`) : null;
      s.kidHover = { row: kid, hovered: hv, node: n };
      check(!!hv && !!n && (kid!.title === (n.name || n.symbol) || kid!.title.includes(n.symbol ?? "\u0000")), `hovering the kid row "${kid!.title}" set hovered() to ${hv} (${J(n)})`);
    }
    await page.mouse("mouseMoved", 3, 3);
    await page.key("Escape");
  });

  // ---------------------------------------------------------------- (f)
  await section("f", async (s, check) => {
    await toOverview(page);
    // the overview defaults to market cap (no size param); the "size by" switch lives in the page's .map-tools, never in the
    // engine's own .bm-size control
    const size0 = await param(page, "size");
    s.defaultSize = size0;
    check(size0 === null, `the overview carries ?size=${size0} (market cap is the default: no size param)`);
    const sizeButtons = await page.evalJs<number>(`document.querySelectorAll(".m3 .bm-size button").length`);
    check(sizeButtons === 0, `${sizeButtons} .bm-size buttons inside the map (the size switch belongs to the page, not the engine)`);
    await settle(page);
    await sleep(600);
    const r = await page.evalJs<{ dom: { mint: string; symbol: string | null; share: number }[] | null; cl: { root: string; tag: string; title: string }[]; titles: string[]; texts: string[]; look: string | null }>(`(() => { const d = __sporeMapPage.dominance(5); return { dom: d ? d.mcap.top : null, cl: __sporeMap.clusters(120), titles: __sporeMap.titles(), texts: [...document.querySelectorAll(".m3 .m3-labels .lb.pl")].map((e) => e.textContent), look: typeof __sporeMap.look === "function" ? __sporeMap.look() : null }; })()`);
    const galaxyTitles = r.look === "galaxy";   // galaxy: "N · 38%"; flat: "38% · N coins"
    if (check(!!r.dom && r.dom.length >= 5, "__sporeMapPage.dominance() returned no mcap table")) {
      const rows = r.dom!.map((d) => {
        const want = sharePct(d.share), c = r.cl.find((x) => x.root === d.mint), shown = r.titles.includes(d.mint);
        const inLabel = shown ? r.texts.some((t) => galaxyTitles ? t.includes(` · ${want}`) : t.includes(`${want} · `)) : null;
        return { mint: d.mint, symbol: d.symbol, want, tag: c?.tag ?? null, shown, inLabel };
      });
      s.top5 = rows;
      for (const x of rows) {
        check(x.tag === x.want, `$${x.symbol}: engine tag ${x.tag}, dominance mcap says ${x.want}`);
        if (x.shown) check(x.inLabel === true, `$${x.symbol}: no planet label reads "${galaxyTitles ? `… · ${x.want}` : `${x.want} · …`}"`);
      }
      check(rows.filter((x) => x.shown).length >= 3, `only ${rows.filter((x) => x.shown).length} of the top-5 mcap families are labelled`);
    }
    s.shot = await shot(page, "f-mcap.png");
    await page.reload();
    await page.waitFor(mapReadyJs("three"), 60_000, "the map after the reload");
    const buttonsAfter = await page.evalJs<number>(`document.querySelectorAll(".m3 .bm-size button").length`);
    const sizeAfter = await param(page, "size");
    s.afterReload = { buttons: buttonsAfter, size: sizeAfter };
    check(buttonsAfter === 0, `after a reload ${buttonsAfter} .bm-size buttons (expected none)`);
    check(sizeAfter === null, `after a reload ?size=${sizeAfter} (expected none)`);
  });

  // ---------------------------------------------------------------- (g)
  await section("g", async (s, check) => {
    await toOverview(page);
    await spa(page, "/map?hl=ours");
    await page.waitFor(`document.querySelector('.map-hl-chip[data-key="ours"]')?.getAttribute("aria-pressed") === "true"`, 4000, "ours chip").catch(() => check(false, "?hl=ours did not press the ours chip"));
    const ok = await page.waitFor(`(() => { const E = __sporeMap.eng; if (!E) return false; let n = 0; for (let i = 0; i < E.coins(); i++) if (E.hlBit(i)) n++; return n === __sporeMapPage.hlCounts().ours && n > 0; })()`, 6000, "the mask").then(() => true, () => false);
    const r = await page.evalJs<{ ones: number; coins: number; counted: number }>(`(() => { const E = __sporeMap.eng; let ones = 0; for (let i = 0; i < E.coins(); i++) if (E.hlBit(i)) ones++; return { ones, coins: E.coins(), counted: __sporeMapPage.hlCounts().ours }; })()`);
    const ours = truth.filter((x) => x.ours).map((x) => x.mint);
    const per = await page.evalJs<{ known: number; lit: number; badOff: string[] }>(`(() => { const M = __sporeMap; let known = 0, lit = 0; const badOff = []; for (const m of ${J(ours)}) { if (!M.has(m)) continue; known++; if (M.hl(m) === 1) lit++; else if (badOff.length < 5) badOff.push(m); } return { known, lit, badOff }; })()`);
    Object.assign(s, r, { oursInApi: ours.length, oursOnMap: per });
    check(ok && r.ones === r.counted, `hl() = 1 on ${r.ones} coins, hlCounts().ours = ${r.counted}`);
    check(per.known > 0 && per.lit === per.known, `ours coins on the map ${per.known}, lit ${per.lit} (unlit: ${per.badOff.join(", ")})`);
    s.shot = await shot(page, "g-hl-ours.png");
    await spa(page, "/map");
    await sleep(500);
  });

  // ---------------------------------------------------------------- (h)
  await section("h", async (s, check) => {
    await toOverview(page);
    // a trade on a visible coin: the largest visible child, else a planet top
    const cands = await page.evalJs<string[]>(`(() => { const M = __sporeMap, R = __qa.insetRect(); const kids = M.sample(4000).map((p) => ({ m: p.mint, s: M.screenOf(p.mint) })).filter((k) => k.s && __qa.inRect(k.s, R, 4)).sort((a, b) => b.s.r - a.s.r).slice(0, 2).map((k) => k.m); const tops = M.clusters(20).map((c) => c.root).filter((m) => __qa.inRect(M.screenOf(m), R, 4)).slice(0, 1); return [...kids.slice(0, 1), ...tops, ...kids.slice(1)]; })()`);
    const attempts: unknown[] = [];
    let lit = false;
    for (const m of cands) {
      const a = await page.evalJs<{ mint: string; before: number; after: number; fxAt: number; fxMax: number }>(`(async () => { const M = __sporeMap, m = ${J(m)}; const before = M.lastTrade(m); const t0 = performance.now(); __sse("trade", { sig: "QAtrade" + Date.now(), mint: m, slot: 1, time: Math.floor(Date.now() / 1000), isBuy: true, user: "qa", baseAmount: "1", quoteAmount: "1", priceQuote: 1, priceUsd: 1, valueUsd: 750 }); let fxAt = -1, fxMax = 0; while (performance.now() - t0 < 300) { const f = M.fx(); if (f > fxMax) fxMax = f; if (f > 0 && fxAt < 0) fxAt = Math.round(performance.now() - t0); await new Promise((r) => requestAnimationFrame(r)); } return { mint: m, before, after: M.lastTrade(m), fxAt, fxMax }; })()`);
      attempts.push(a);
      if (a.fxAt >= 0 && a.after > a.before) { lit = true; break; }
      await sleep(1600); // let the flash window pass before the next candidate
    }
    s.trade = attempts;
    check(cands.length > 0, "no visible coin to trade");
    check(lit, `no trade on a visible coin lit fx() within 300 ms with lastTrade advanced (${J(attempts)})`);
    // a pair under a visible parent
    const parent = await page.evalJs<Record<string, unknown> | null>(`(() => { const M = __sporeMap, R = __qa.insetRect(); for (const c of M.clusters(30)) { if (__qa.inRect(M.screenOf(c.root), R, 10)) return M.node(c.root); } return null; })()`);
    if (check(!!parent, "no visible parent for a pair")) {
      const mint = ("QApair" + Date.now().toString(36) + Math.random().toString(36).slice(2)).padEnd(44, "x").slice(0, 44);
      const nowS = Math.floor(Date.now() / 1000);
      const P = parent as Record<string, unknown>;
      const payload = { coin: { mint, name: "QA pair", symbol: "QAP", image: null, depth: Number(P.depth ?? 0) + 1, mcapUsd: 4200, lockedUsd: null, children: 0, descendants: 0, migrated: false, ours: false, createdAt: nowS, parentMint: P.mint },
        parent: { mint: P.mint, name: P.name ?? null, symbol: P.symbol ?? null, image: P.image ?? null, depth: P.depth ?? 0, mcapUsd: P.mcapUsd ?? null, lockedUsd: P.lockedUsd ?? null, children: P.children ?? 0, descendants: P.descendants ?? 0, migrated: !!P.migrated, createdAt: P.createdAt ?? null } };
      const r = await page.evalJs<{ n0: number; n1: number; b0: number; b1: number; hasAt: number; toast: string | null }>(`(async () => { const M = __sporeMap; const n0 = M.nodes(), b0 = M.builds(); const t0 = performance.now(); __sse("pair", ${J(payload)}); let hasAt = -1, toast = null; while (performance.now() - t0 < 1600) { if (hasAt < 0 && M.has(${J(mint)})) hasAt = Math.round(performance.now() - t0); const l = document.querySelector(".m3 .m3-labels"); const t = l ? [...l.querySelectorAll(".lb")].map((e) => e.textContent).find((x) => x.includes("new ·")) : null; if (t && !toast) toast = t; if (hasAt >= 0 && toast) break; await new Promise((r) => setTimeout(r, 25)); } return { n0, n1: M.nodes(), b0, b1: M.builds(), hasAt, toast }; })()`);
      s.pair = { mint, parent: P.mint, ...r };
      check(r.hasAt >= 0 && r.hasAt <= 1000, `has(child) after ${r.hasAt} ms (need ≤ 1000)`);
      check(r.n1 === r.n0 + 1, `nodes() ${r.n0} → ${r.n1} after one pair`);
      check(r.b1 === r.b0, `the pair rebuilt the map (builds ${r.b0} → ${r.b1})`);
      check(!!r.toast, "no \"new ·\" toast label after the pair");
      s.shotPair = await shot(page, "h-pair.png");
    }
    // a 300-trade burst over 5 s
    await sleep(1500);
    const t0 = await page.evalJs<number>(`(() => { const M = __sporeMap, R = __qa.insetRect(); const pairs = M.sample(600).filter((p) => __qa.inRect(M.screenOf(p.parent), R)); const use = pairs.length ? pairs : M.sample(300); const N = 300; const B = window.__burst = { done: false, t0: performance.now(), t1: 0, n: 0, fxMax: 0 }; let i = 0; const tick = () => { const due = Math.min(N, Math.ceil((performance.now() - B.t0) / (5000 / N))); for (; i < due; i++) { const p = use[i % use.length]; __sse("trade", { sig: "QAburst" + i + Math.random().toString(36).slice(2), mint: i % 2 ? p.mint : p.parent, slot: 0, time: Math.floor(Date.now() / 1000), isBuy: Math.random() < 0.55, user: "qa", baseAmount: 1, quoteAmount: 1, priceQuote: 1, priceUsd: 1, valueUsd: 5 + Math.random() * 2000 }); } B.n = i; const f = M.fx(); if (f > B.fxMax) B.fxMax = f; if (i < N) setTimeout(tick, 8); else { B.done = true; B.t1 = performance.now(); } }; tick(); return B.t0; })()`);
    await page.waitFor("window.__burst && window.__burst.done", 12_000, "the burst");
    await sleep(300);
    const t1 = await page.evalJs<number>("window.__burst.t1 + 300");
    const burst = await page.evalJs<RafStats>(rafStatsJs(t0, String(t1)));
    s.burst = { trades: await page.evalJs<number>("window.__burst.n"), fxMax: await page.evalJs<number>("window.__burst.fxMax"), frames: burst, live: await page.evalJs("__sporeMap.live()") };
    check(!!burst && burst.p95 <= 17.5, `burst: rAF p95 ${burst?.p95} ms (≤ 17.5)`);
    check(!!burst && burst.longTasks === 0, `burst: ${burst?.longTasks} long task(s), longest ${burst?.longTaskMaxMs} ms`);
    s.shotBurst = await shot(page, "h-burst.png");
    // a mapdelta patches the node's market cap without a rebuild
    const md = await page.evalJs<{ mint: string; v0: number | null; n: Record<string, unknown> } | null>(`(() => { const M = __sporeMap; for (const p of M.sample(50)) { const n = M.node(p.mint); if (n && n.mcapUsd > 0) return { mint: p.mint, v0: n.mcapUsd, n }; } return null; })()`);
    if (check(!!md, "no coin to patch with a mapdelta")) {
      const v1 = Math.round((md!.v0 ?? 1000) * 3 * 100) / 100;
      const b0 = await page.evalJs<number>("__sporeMap.builds()");
      await page.evalJs(`__sse("mapdelta", { at: Date.now(), updated: [{ mint: ${J(md!.mint)}, mcapUsd: ${v1}, lockedUsd: ${J(md!.n.lockedUsd ?? null)}, children: ${J(md!.n.children ?? 0)}, descendants: ${J(md!.n.descendants ?? 0)}, migrated: ${J(!!md!.n.migrated)} }] })`);
      const ok = await page.waitFor(`(__sporeMap.node(${J(md!.mint)}) || {}).mcapUsd === ${v1}`, 3000, "the mapdelta").then(() => true, () => false);
      const b1 = await page.evalJs<number>("__sporeMap.builds()");
      s.mapdelta = { mint: md!.mint, v0: md!.v0, v1, ok, b0, b1 };
      check(ok, "node().mcapUsd did not take the mapdelta value");
      check(b1 === b0, `the mapdelta rebuilt the map (builds ${b0} → ${b1})`);
    }
  });

  // ---------------------------------------------------------------- (i)
  await section("i", async (s, check) => {
    const fam = truth.filter((r) => r.parentMint && r.depth >= 1);
    const mints = [fam[0], fam[Math.floor(fam.length / 3)], fam[Math.floor((2 * fam.length) / 3)]].filter(Boolean).map((r) => r.mint);
    const nowS = Math.floor(Date.now() / 1000);
    let reply = { status: 200, body: J({ at: nowS, since: nowS - 86_400, mint: mints, t1h: [5, 2, 1], n24: [9, 4, 2], v24: [120.5, 33, 2.25], last: [nowS - 30, nowS - 400, nowS - 1_200], buys1h: [3, 1, 0] }) };
    let hits = 0;
    await page.intercept(["*/api/map/heat*"], async (p) => { hits++; await page.fulfill(p.requestId, reply.status, reply.body); });
    try {
      const mark200 = consoleMark(page);
      await openMap(page, "/map");
      await sleep(2500);
      const normal = new Set(consoleSince(page, mark200)); // what any load prints (a dev build: library notices)
      const ok = await page.waitFor(`${J(mints)}.every((m) => __sporeMap.lastTrade(m) > 0)`, 10_000, "heat rows").then(() => true, () => false);
      const seeded = await page.evalJs<{ last: number[]; t1h: number[] }>(`({ last: ${J(mints)}.map((m) => __sporeMap.lastTrade(m)), t1h: ${J(mints)}.map((m) => __sporeMap.t1h(m)) })`);
      s.rows = { mints, hits, ...seeded };
      check(hits >= 1, "the page never asked for /api/map/heat");
      check(ok, `the 3 heat rows did not seed lastTrade (${J(seeded.last)})`);
      check(seeded.t1h[0] === 5 && seeded.t1h[1] === 2, `t1h ${J(seeded.t1h)} is not the intercepted [5, 2, 1]`);
      // a 404 (an older server): nothing on the console, the map renders
      reply = { status: 404, body: J({ error: "not found" }) };
      hits = 0;
      const mark = consoleMark(page), errs = page.errors.length;
      await openMap(page, "/map");
      await sleep(2500);
      const out = consoleSince(page, mark).filter((l) => !normal.has(l));
      s.notFound = { hits, console: out, ignoredAsOnEveryLoad: [...normal], renderer: await page.evalJs(RENDERER_JS), nodes: await page.evalJs("__sporeMap.nodes()") };
      check(hits >= 1, "the page never asked for /api/map/heat after the reload");
      check(out.length === 0 && page.errors.length === errs, `a heat 404 produced console output: ${out.slice(0, 3).join(" | ")}`);
      check((await page.evalJs<number>("__sporeMap.nodes()")) > 0, "the map did not render after a heat 404");
    } finally { await page.unintercept(); }
  });

  // ---------------------------------------------------------------- (j)
  await section("j", async (s, check) => {
    await openMap(page, "/map");
    await toOverview(page);
    const top = (await page.evalJs<{ root: string }[]>("__sporeMap.clusters(1)"))[0]?.root;
    const d = await page.evalJs<Record<string, any> | null>(`__sporeMap.dragCoin(${J(top)})`, 30_000); // eslint-disable-line @typescript-eslint/no-explicit-any
    s.dragCoin = d;
    // galaxy (owner list items 6 + 8): no spring-back and no neighbour push; the flat look keeps the old sim
    const galaxy = (await page.evalJs<string | null>("__sporeMap.look ? __sporeMap.look() : null")) === "galaxy";
    s.look = galaxy ? "galaxy" : "flat";
    if (galaxy && check(!!d, "dragCoin(top) returned null")) {
      check(d!.neighbourMaxPx === 0, `dragCoin (galaxy): neighbourMaxPx ${d!.neighbourMaxPx} (need 0)`);
      check(typeof d!.dropDeltaPx === "number" && d!.dropDeltaPx <= 2, `dragCoin (galaxy): dropDeltaPx ${d!.dropDeltaPx} (need ≤ 2)`);
    } else if (check(!!d, "dragCoin(top) returned null")) {
      check(d!.coinsOffHome === 0, `dragCoin: ${d!.coinsOffHome} coins off home after the settle`);
      check(!!d!.held && d!.held.p95 <= 17.5, `dragCoin: held p95 ${d!.held?.p95} ms (≤ 17.5)`);
      check((d!.intrusion?.maxExtraCoins ?? 1) === 0, `dragCoin: intrusion ${J(d!.intrusion)}`);
    }
    await settle(page);
    // a real mouse drag of the chip by 200 px
    const pt = await page.evalJs<{ x: number; y: number } | null>(`__qa.pointOn(${J(top)}, false, __qa.insetRect())`);
    if (!check(!!pt, "no point on the top's chip")) return;
    const n0 = await page.evalJs<number>(`(() => { const a = __sporeMap.allXY(); window.__xy0 = { n: a.n, x: Float64Array.from(a.x), y: Float64Array.from(a.y) }; return a.n; })()`);
    const dir = pt!.x + 220 < W - 20 ? 1 : -1;
    await page.mouse("mouseMoved", pt!.x, pt!.y);
    await page.mouse("mousePressed", pt!.x, pt!.y);
    const held: unknown[] = [];
    for (let i = 1; i <= 20; i++) {
      await page.mouse("mouseMoved", pt!.x + dir * 10 * i, pt!.y, { button: "left", buttons: 1 });
      await sleep(16);
      if (i === 10 || i === 20) held.push(await page.evalJs("__sporeMap.drag()"));
    }
    await sleep(150);
    held.push(await page.evalJs("__sporeMap.drag()"));
    await page.mouse("mouseReleased", pt!.x + dir * 200, pt!.y);
    const rest = await page.waitFor(SETTLED_JS + " && !__sporeMap.drag()", 15_000, "the rest").then(() => true, () => false);
    await sleep(2000);
    const cmp = await page.evalJs<{ n0: number; n1: number; max: number; off: number }>(`(() => { const a = __sporeMap.allXY(), b = window.__xy0; let max = 0, off = 0; if (a.n !== b.n) return { n0: b.n, n1: a.n, max: -1, off: -1 }; for (let i = 0; i < a.n; i++) { const d = Math.max(Math.abs(a.x[i] - b.x[i]), Math.abs(a.y[i] - b.y[i])); if (d > max) max = d; if (d > 1e-6) off++; } return { n0: b.n, n1: a.n, max, off }; })()`);
    s.mouseDrag = { point: pt, n0, held, rest, cmp };
    check(held.length > 0 && held.every((h) => !!h && (h as { n: number }).n === 1), `drag() while held: ${J(held)}`);
    check(rest, "the map did not come to rest within 15 s of the release");
    if (galaxy) {
      // the dragged family stays where it was dropped; every coin that moved belongs to it
      const fam = await page.evalJs<{ moved: number; foreign: number; topD: number; k: number }>(`(() => { const e = __sporeMap.eng, a = e.allXY(), b = window.__xy0, top = e.indexOf(${J(top)}); const inF = new Set([top]); const q = [top]; while (q.length) { const i = q.shift(); for (const c of e.children(i)) if (!inF.has(c)) { inF.add(c); q.push(c); } } let moved = 0, foreign = 0; for (let i = 0; i < a.n; i++) { const d = Math.max(Math.abs(a.x[i] - b.x[i]), Math.abs(a.y[i] - b.y[i])); if (d > 1e-6) { moved++; if (!inF.has(i)) foreign++; } } return { moved, foreign, topD: Math.hypot(a.x[top] - b.x[top], a.y[top] - b.y[top]), k: __sporeMap.camera().k }; })()`);
      s.galaxyDrop = fam;
      check(cmp.n0 === cmp.n1 && fam.foreign === 0, `galaxy: ${fam.foreign} coins outside the dragged family moved`);
      check(fam.topD * fam.k >= 0.95 * 200, `galaxy: the top kept ${Math.round(fam.topD * fam.k)} px of the 200 px drag (need ≥ 190)`);
    } else
    check(cmp.n0 === cmp.n1 && cmp.off === 0, `allXY after the rest differs from before the press: ${cmp.off} coins moved (max ${cmp.max})`);
    await page.mouse("mouseMoved", 3, 3);
  });

  // ---------------------------------------------------------------- (k)
  await section("k", async (s, check) => {
    const ph = await browser.newPage({ width: 390, height: 844, dpr: 2, mobile: true, touch: true, prelude: [MOCK_ES, RAF_PROBE, QA_HELPERS] });
    pages.push(ph);
    try {
      await openMap(ph, "/map");
      await settle(ph);
      await sleep(600);
      const ov = await ph.evalJs<{ labels: Record<string, number> | null; top5: { root: string; p: { x: number; y: number } | null }[]; overflowX: boolean; roots: string | null; k: number; dpr: number }>(`({ labels: __sporeMap.labelStats(), top5: __sporeMap.clusters(5).map((c) => ({ root: c.root, p: __sporeMap.familyScreen(c.root) })), overflowX: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth, roots: new URLSearchParams(location.search).get("roots"), k: __sporeMap.zoom(), dpr: devicePixelRatio })`);
      s.overview = ov;
      sections.b = sections.b ?? {};
      (sections.b as Record<string, unknown>).phone390 = { overlaps: ov.labels?.overlaps, labelHud: ov.labels?.labelHud, foreignColony: ov.labels?.foreignColony };
      check(!!ov.labels && ov.labels.foreignColony === 0, `(b at 390×844) labelStats().foreignColony ${ov.labels?.foreignColony}`);
      check(!!ov.labels && ov.labels.overlaps === 0, `(b at 390×844) labelStats().overlaps ${ov.labels?.overlaps}`);
      check(!!ov.labels && ov.labels.labelHud === 0, `(b at 390×844) labelStats().labelHud ${ov.labels?.labelHud}`);
      check(ov.top5.length === 5 && ov.top5.every((t) => !!t.p && t.p.x >= 0 && t.p.x <= 390 && t.p.y >= 0 && t.p.y <= 844), `top-5 families not all on screen: ${J(ov.top5)}`);
      check(!ov.overflowX, "horizontal overflow at 390 px");
      check(ov.roots === null, `?roots=${ov.roots} on the phone under three (expected unset)`);
      s.shotOverview = await shot(ph, "k-phone-overview.png");
      // a tap on a planet chip → the docked card
      // (final fix) the LOWEST tappable chip of the top 20, so the docked card would cover it and the nudge is exercised
      const chip = await ph.evalJs<{ mint: string; x: number; y: number } | null>(`(() => { const M = __sporeMap, R = __qa.insetRect(); let best = null; for (const c of M.clusters(20)) { const p = __qa.pointOn(c.root, false, R); if (p && (!best || p.y > best.y)) best = { mint: c.root, x: p.x, y: p.y }; } return best; })()`);
      if (!check(!!chip, "no planet chip to tap on the phone")) return;
      await ph.tap(chip!.x, chip!.y);
      const dock = await ph.waitFor<{ bottom: number; limit: number; text: string }>(`(() => { const t = document.querySelector(".m3 .m3-tip.dock.on"); if (!t) return null; const r = t.getBoundingClientRect(), root = document.querySelector(".bm.m3").getBoundingClientRect(), i = __sporeMapPage.inset() || {}; return { bottom: r.bottom, limit: root.bottom - (i.bottom || 0), text: t.textContent.slice(0, 120) }; })()`, 2500, "the docked card").catch(() => null);
      s.dock = { chip, dock };
      if (!check(!!dock, "a tap did not show .m3-tip.dock.on")) return;
      check(dock!.bottom <= dock!.limit + 0.5, `the docked card's bottom ${dock!.bottom} is below the bottom inset ${dock!.limit}`);
      // (final fix) the card never covers its coin (the camera nudges it above the card) and the +/- column steps aside
      await sleep(700);
      const cover = await ph.evalJs<{ coinBottom: number; cardTop: number; controls: string } | null>(`(() => { const s = __sporeMap.screenOf(${J(chip!.mint)}); const t = document.querySelector(".m3 .m3-tip.dock.on"), c = document.querySelector(".m3 .bm-controls"); if (!s || !t) return null; return { coinBottom: Math.round(s.y + s.r), cardTop: Math.round(t.getBoundingClientRect().top), controls: c ? getComputedStyle(c).visibility : "none" }; })()`);
      s.cover = cover;
      check(!!cover && cover.coinBottom <= cover.cardTop, `the docked card covers the tapped chip ${J(cover)}`);
      check(!!cover && cover.controls !== "visible", `the +/- column stays visible under the docked card ${J(cover)}`);
      s.shotDock = await shot(ph, "k-phone-dock.png");
      const btn = await ph.evalJs<{ x: number; y: number; text: string } | null>(`(() => { const b = [...document.querySelectorAll(".m3 .m3-tip.dock.on button")].find((x) => /open family|select/i.test(x.textContent)); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: b.textContent.trim() }; })()`);
      if (!check(!!btn, "the docked card has no \"Open family\" / \"Select\" button")) return;
      await ph.tap(btn!.x, btn!.y);
      const focus = await ph.waitFor<string>(`new URLSearchParams(location.search).get("focus")`, 3000, "?focus from the dock").catch(() => null);
      check(!!focus, `"${btn!.text}" did not set ?focus`);
      const peek = await ph.waitFor(`!!document.querySelector(".map-sheet.peek") && __qa.visible(".map-sheet")`, 3000, "the sheet in peek").then(() => true, () => false);
      check(peek, ".map-sheet.peek is not visible");
      await ph.waitFor("!__sporeMap.flying()", 6000, "the flight").catch(() => null);
      await settle(ph);
      await sleep(900);
      const g = await ph.evalJs<{ sel: string | null; pt: { x: number; y: number } | null; overlayBottom: number; sheetTop: number; overflowX: boolean }>(`(() => { const sel = __sporeMap.selected(); const sh = document.querySelector(".map-sheet"), ov = document.querySelector(".map-overlay"); return { sel, pt: sel ? __sporeMap.screenOf(sel) : null, overlayBottom: ov ? ov.getBoundingClientRect().bottom : 0, sheetTop: sh ? sh.getBoundingClientRect().top : 844, overflowX: document.documentElement.scrollWidth > innerWidth }; })()`);
      s.open = { button: btn!.text, focus, peek, ...g };
      check(!!focus && g.sel === focus, `selected() ${g.sel} vs ?focus ${focus}`);
      check(!!g.pt && g.pt.y > g.overlayBottom && g.pt.y < g.sheetTop, `the selected coin at y=${g.pt?.y} is not between the overlay (${g.overlayBottom}) and the sheet (${g.sheetTop})`);
      check(!g.overflowX, "horizontal overflow with the sheet open");
      s.shotPeek = await shot(ph, "k-phone-peek.png");
      // long-press 320 ms and move 80 px → a held coin
      const coin = await ph.evalJs<{ mint: string; x: number; y: number } | null>(`(() => { const M = __sporeMap, sel = M.selected(); const ov = document.querySelector(".map-overlay").getBoundingClientRect().bottom, sh = document.querySelector(".map-sheet") ? document.querySelector(".map-sheet").getBoundingClientRect().top : innerHeight; const R = { x0: 8, y0: ov + 8, x1: innerWidth - 100, y1: sh - 8 }; const list = [...M.children(sel || ""), sel].filter(Boolean).map((m) => ({ m, s: M.screenOf(m) })).filter((k) => k.s && k.s.r >= 6).sort((a, b) => b.s.r - a.s.r); for (const k of list) { const p = __qa.pointOn(k.m, false, R); if (p) return { mint: k.m, x: p.x, y: p.y }; } return null; })()`);
      if (check(!!coin, "no coin ≥ 6 px to long-press between the overlay and the sheet")) {
        await ph.touch("touchStart", [{ x: coin!.x, y: coin!.y }]);
        await sleep(320);
        for (let i = 1; i <= 8; i++) { await ph.touch("touchMove", [{ x: coin!.x + 10 * i, y: coin!.y }]); await sleep(16); }
        const held = await ph.evalJs("__sporeMap.drag()");
        await ph.touch("touchEnd", []);
        s.longPress = { coin, held };
        check(!!held, "a 320 ms long-press + 80 px move did not hold a coin (drag() null)");
        await settle(ph, 15_000);
      }
    } finally { await ph.close(); }
  });

  // ---------------------------------------------------------------- (l)
  await section("l", async (s, check) => {
    const idleRenders = async (p: Page) => {
      // A logo that arrives is a content change and renders once (bubbles' atlas upload hook). Measured: under reduced
      // motion the overview renders 2–4 times a second while the app's image loader drains (~118 logos in ~10 s
      // through the proxy) and 0 times once the queue is empty, so the idle window starts after the queue drains.
      const tLogo = Date.now();
      const drained = await p.waitFor(`(() => { const i = __sporeMap.images(); return !!i && i.queued === 0 && i.inflight === 0; })()`, 45_000, "the logo queue to drain").then(() => true, () => false);
      const logoWaitMs = Date.now() - tLogo;
      // the engine re-checks loaded logos at most every 250 ms, so the last upload lands up to ~300 ms after the drain
      await sleep(1500);
      for (let attempt = 0; attempt < 2; attempt++) {
        const a = await p.evalJs<{ r: number; heatAt: number }>(`({ r: __sporeMap.motion().renders, heatAt: (__sporeMap.sync() || {}).heatAt || 0 })`);
        await sleep(5000);
        const b = await p.evalJs<{ r: number; heatAt: number }>(`({ r: __sporeMap.motion().renders, heatAt: (__sporeMap.sync() || {}).heatAt || 0 })`);
        if (b.r - a.r === 0 || b.heatAt === a.heatAt) return { renders: b.r - a.r, heatPollInWindow: b.heatAt !== a.heatAt, attempt, logoWaitMs, drained };
      }
      return { renders: -1, heatPollInWindow: true, attempt: 2, logoWaitMs, drained };
    };
    const tradeFx = (p: Page) => p.evalJs<{ mint: string | null; fxMax: number; before: number; after: number }>(`(async () => { const M = __sporeMap, R = __qa.insetRect(); const m = (M.sample(2000).find((q) => __qa.inRect(M.screenOf(q.mint), R, 4)) || {}).mint || M.anyRoot(); const before = M.lastTrade(m); __sse("trade", { sig: "QArm" + Date.now(), mint: m, slot: 1, time: Math.floor(Date.now() / 1000), isBuy: true, user: "qa", baseAmount: "1", quoteAmount: "1", priceQuote: 1, priceUsd: 1, valueUsd: 50000 }); let fxMax = 0; const t0 = performance.now(); while (performance.now() - t0 < 300) { fxMax = Math.max(fxMax, M.fx()); await new Promise((r) => setTimeout(r, 16)); } return { mint: m, fxMax, before, after: M.lastTrade(m) }; })()`);
    // the OS preference
    const b2 = await launchChrome({ gpu: GPU, width: W, height: H, reducedMotion: true });
    browsers.push(b2);
    const rm = await b2.newPage({ prelude: [MOCK_ES, RAF_PROBE, QA_HELPERS] });
    pages.push(rm);
    try {
      await openMap(rm, "/map");
      await settle(rm);
      await sleep(1000);
      const reduced = await rm.evalJs<boolean>("!!__sporeMap.motion().reduced");
      const idle = await idleRenders(rm);
      const fx = await tradeFx(rm);
      s.os = { reduced, idle, trade: fx };
      check(reduced, "motion().reduced is false under --force-prefers-reduced-motion");
      check(idle.renders === 0, `${idle.renders} renders over 5 s idle under the OS reduced-motion preference`);
      check(fx.fxMax === 0, `a trade lit fx() ${fx.fxMax} under reduced motion`);
      check(fx.after >= fx.before, "the trade did not update lastTrade under reduced motion");
      s.shotOs = await shot(rm, "l-reduced-os.png");
    } finally { await b2.close(); browsers.splice(browsers.indexOf(b2), 1); }
    // the site's own toggle (localStorage spore:motion = paused → html[data-motion="paused"])
    if (!(await page.evalJs<boolean>(`location.protocol.startsWith("http")`))) await page.navigate(BASE + u("/"), 60_000);   // --only l: still on about:blank
    await page.evalJs(`(localStorage.setItem("spore:motion", "paused"), true)`);
    try {
      await openMap(page, "/map");
      await settle(page);
      await sleep(1000);
      const attr = await page.evalJs<string | undefined>("document.documentElement.dataset.motion");
      const reduced = await page.evalJs<boolean>("!!__sporeMap.motion().reduced");
      const idle = await idleRenders(page);
      const fx = await tradeFx(page);
      s.site = { dataMotion: attr, reduced, idle, trade: fx };
      check(attr === "paused", `html[data-motion] is ${attr}`);
      check(reduced, "motion().reduced is false under html[data-motion=paused]");
      check(idle.renders === 0, `${idle.renders} renders over 5 s idle under data-motion=paused`);
      check(fx.fxMax === 0, `a trade lit fx() ${fx.fxMax} under data-motion=paused`);
    } finally {
      await page.evalJs(`(localStorage.removeItem("spore:motion"), true)`).catch(() => null);
      await openMap(page, "/map").catch(() => null);
    }
  });

  // ---------------------------------------------------------------- (m)
  await section("m", async (s, check) => {
    const b3 = await launchChrome({ gpu: "none", width: W, height: H });
    browsers.push(b3);
    const nog = await b3.newPage({ prelude: [MOCK_ES] });
    pages.push(nog);
    try {
      await openMap(nog, "/map", "classic");
      await sleep(1500);
      const r = await nog.evalJs<{ renderer: string; fallback: string | null; bm: boolean; m3: boolean }>(`({ renderer: ${RENDERER_JS}, fallback: ${FALLBACK_JS}, bm: !!document.querySelector(".bm-canvas"), m3: !!document.querySelector(".m3-canvas") })`);
      s.noGpu = { ...r, errors: nog.errors.slice(), warnings: nog.warnings.slice(0, 5) };
      check(r.renderer === "classic" && r.fallback === "no-webgl2", `--disable-gpu: renderer ${r.renderer}, fallback ${r.fallback}`);
      check(r.bm && !r.m3, `--disable-gpu: .bm-canvas ${r.bm}, .m3-canvas ${r.m3}`);
      check(nog.errors.length === 0, `--disable-gpu: ${nog.errors.length} console error(s): ${nog.errors.slice(0, 3).join(" | ")}`);
      s.shotNoGpu = await shot(nog, "m-no-gpu.png");
    } finally { await b3.close(); browsers.splice(browsers.indexOf(b3), 1); }
    // ?renderer=classic
    await openMap(page, "/map?renderer=classic", "classic");
    await sleep(1000);
    const c = await page.evalJs<{ renderer: string; fallback: string | null; bm: boolean; m3: boolean; chunk: string[] }>(`({ renderer: ${RENDERER_JS}, fallback: ${FALLBACK_JS}, bm: !!document.querySelector(".bm-canvas"), m3: !!document.querySelector(".m3-canvas"), chunk: ${map3AssetsJs} })`);
    s.param = c;
    check(c.renderer === "classic" && c.fallback === "param", `?renderer=classic: renderer ${c.renderer}, fallback ${c.fallback}`);
    check(c.bm && !c.m3, `?renderer=classic: .bm-canvas ${c.bm}, .m3-canvas ${c.m3}`);
    if (c.chunk.length) notes.push(`(m) ?renderer=classic still loaded the map3 chunk: ${c.chunk.join(", ")}`);
    // ?m3fail
    const errs = page.errors.length, mark = consoleMark(page);
    await openMap(page, "/map?m3fail", "classic");
    await sleep(1500);
    const f = await page.evalJs<{ renderer: string; fallback: string | null; bm: boolean }>(`({ renderer: ${RENDERER_JS}, fallback: ${FALLBACK_JS}, bm: !!document.querySelector(".bm-canvas") })`);
    const out = consoleSince(page, mark);
    s.m3fail = { ...f, console: out, newErrors: page.errors.slice(errs) };
    check(f.renderer === "classic" && f.fallback === "mount-error", `?m3fail: renderer ${f.renderer}, fallback ${f.fallback}`);
    check(f.bm, "?m3fail: no .bm-canvas");
    check(page.errors.length === errs, `?m3fail: console error(s): ${page.errors.slice(errs, errs + 3).join(" | ")}`);
    s.shotM3fail = await shot(page, "m-m3fail.png");
    const rendererNow = () => page.evalJs<{ renderer: string; fallback: string | null; sticky: string | null; flag: string | null }>(`({ renderer: ${RENDERER_JS}, fallback: ${FALLBACK_JS}, sticky: localStorage.getItem("spore:map3:fail"), flag: localStorage.getItem("spore:map3:flag") })`);
    // a forced test failure is not remembered: the next plain visit runs the WebGL map
    await openMap(page, "/map");
    const after = await rendererNow();
    s.afterM3fail = after;
    check(after.renderer === "three" && !after.sticky, `after ?m3fail the next visit is ${J(after)} (three, nothing remembered)`);
    // the kill switch: /map-renderer.json says classic → this visit hands over to classic ("off"); the real file (three)
    // brings the WebGL map back on the visit after the one that reads it
    const errsK = page.errors.length;
    await page.intercept(["*/map-renderer.json*"], async (p) => { await page.fulfill(p.requestId, 200, J({ renderer: "classic" })); });
    try {
      await page.navigate(BASE + u("/map"), 60_000);
      const off = await page.waitFor<{ renderer: string; fallback: string | null }>(`(() => { const r = ${RENDERER_JS}, f = ${FALLBACK_JS}; return r === "classic" && f === "off" ? { renderer: r, fallback: f } : null; })()`, 15_000, "the kill switch").catch(() => null);
      const k1 = await rendererNow();
      s.killSwitch = { off: k1 };
      check(!!off, `the kill switch (classic) left the page at ${J(k1)}`);
    } finally { await page.unintercept(); }
    await openMap(page, "/map", "classic");
    const k2 = await rendererNow();
    await sleep(1500);
    await openMap(page, "/map", "three");
    const k3 = await rendererNow();
    Object.assign(s.killSwitch as Record<string, unknown>, { nextVisit: k2, thenThree: k3 });
    check(k2.renderer === "classic" && k2.fallback === "off", `the visit after the kill switch starts ${J(k2)} (classic / off from the cached flag)`);
    check(k3.renderer === "three" && !k3.flag, `the kill switch did not lift after the real file was read: ${J(k3)}`);
    check(page.errors.length === errsK, `kill switch: console error(s): ${page.errors.slice(errsK, errsK + 3).join(" | ")}`);
    // three lost WebGL contexts: two rebuilds, then classic / context-lost; the next visit stays classic ("sticky") until
    // ?renderer=three clears the record
    await settle(page);
    const losses: unknown[] = [];
    for (let n = 0; n < 3; n++) {
      const b0 = await page.evalJs<number>("__sporeMap.builds()");
      const lost = await page.evalJs<boolean>(`(() => { const c = [...document.querySelectorAll(".m3-layer:not(.out):not(.pending) canvas.m3-canvas")].pop(); const gl = c && c.getContext("webgl2"); const x = gl && gl.getExtension("WEBGL_lose_context"); if (!x) return false; x.loseContext(); return true; })()`);
      const next = n < 2
        ? await page.waitFor(`!!window.__sporeMap && __sporeMap.builds() > ${b0}`, 12_000, `the rebuild after loss ${n + 1}`).then(() => "rebuilt", () => "no rebuild")
        : await page.waitFor(`${RENDERER_JS} === "classic"`, 12_000, "the fallback after the third loss").then(() => "classic", () => "still three");
      losses.push({ n: n + 1, lost, next });
      if (n < 2) await settle(page, 15_000);
    }
    const lostState = await rendererNow();
    await openMap(page, "/map", "classic");
    const sticky = await rendererNow();
    await openMap(page, "/map?renderer=three", "three");
    const forced = await rendererNow();
    await openMap(page, "/map", "three");
    const cleared = await rendererNow();
    s.contextLoss = { losses, lostState, sticky, forced, cleared };
    check(lostState.renderer === "classic" && lostState.fallback === "context-lost" && !!lostState.sticky, `three context losses ended at ${J(lostState)} (classic / context-lost, remembered)`);
    check(sticky.renderer === "classic" && sticky.fallback === "sticky", `the visit after a lost context is ${J(sticky)} (classic / sticky)`);
    check(forced.renderer === "three" && !forced.sticky, `?renderer=three gave ${J(forced)} (three, record cleared)`);
    check(cleared.renderer === "three", `the next plain visit is ${J(cleared)}`);
  });

  // ---------------------------------------------------------------- (n)
  await section("n", async (s, check) => {
    await openMap(page, "/map");
    await settle(page);
    const ctxWarn = () => page.logs.filter((l) => /Too many active WebGL contexts/i.test(l)).length;
    const w0 = ctxWarn();
    const cycles: Record<string, unknown>[] = [];
    for (let c = 1; c <= 5; c++) {
      await spa(page, "/");
      const gone = await page.waitFor(`!window.__sporeMap && !!window.__sporeMap3 && __sporeMap3.counters().live === 0`, 6000, "unmount").then(() => true, () => false);
      await sleep(1200);
      const counters = await page.evalJs<{ live: number; created: number; destroyed: number } | null>("window.__sporeMap3 ? __sporeMap3.counters() : null");
      const pageHook = await page.evalJs<boolean>("!!window.__sporeMapPage");
      const heap = await page.heapMB();
      const dom = await page.domCounters();
      cycles.push({ cycle: c, gone, counters, pageHookLeft: pageHook, heapMB: heap, ...dom });
      check(gone && !!counters && counters.live === 0, `cycle ${c}: engine counters after unmount ${J(counters)}`);
      check(!pageHook, `cycle ${c}: window.__sporeMapPage survived the unmount`);
      await spa(page, "/map");
      await page.waitFor(mapReadyJs("three"), 60_000, `the map (cycle ${c})`);
      await settle(page, 20_000);
    }
    const c1 = cycles[0] as { heapMB: number; nodes: number; jsEventListeners: number }, c5 = cycles[4] as { heapMB: number; nodes: number; jsEventListeners: number };
    const works = await page.evalJs<{ renderer: string; nodes: number; settled: boolean; live: number }>(`({ renderer: ${RENDERER_JS}, nodes: __sporeMap.nodes(), settled: __sporeMap.settled(), live: __sporeMap3.counters().live })`);
    Object.assign(s, { cycles, heapGrowthMB: Math.round((c5.heapMB - c1.heapMB) * 100) / 100, nodesDrift: (c5.nodes - c1.nodes) / Math.max(1, c1.nodes), listenersDrift: (c5.jsEventListeners - c1.jsEventListeners) / Math.max(1, c1.jsEventListeners), webglWarnings: ctxWarn() - w0, after: works });
    check(c5.heapMB - c1.heapMB <= 8, `heap grew ${(c5.heapMB - c1.heapMB).toFixed(2)} MB from cycle 1 to 5 (≤ 8)`);
    for (const c of cycles.slice(1) as { cycle: number; nodes: number; jsEventListeners: number }[]) {
      check(Math.abs(c.nodes - c1.nodes) / Math.max(1, c1.nodes) <= 0.05, `cycle ${c.cycle}: DOM nodes ${c.nodes} vs ${c1.nodes} at cycle 1 (> 5 %)`);
      check(Math.abs(c.jsEventListeners - c1.jsEventListeners) / Math.max(1, c1.jsEventListeners) <= 0.05, `cycle ${c.cycle}: JS listeners ${c.jsEventListeners} vs ${c1.jsEventListeners} at cycle 1 (> 5 %)`);
    }
    check(ctxWarn() - w0 === 0, "\"Too many active WebGL contexts\" was logged");
    check(works.renderer === "three" && works.nodes > 1000 && works.live === 1, `the map after the 5th return: ${J(works)}`);
    s.shot = await shot(page, "n-after-5-cycles.png");
  });

  // ---------------------------------------------------------------- (o)
  await section("o", async (s, check) => {
    await page.navigate(BASE + u(`/c/${coinRoot.mint}#tree`));
    const coin = await page.waitFor(`!!document.querySelector(".bm-canvas")`, 40_000, "the coin page's tree").then(() => true, () => false);
    await sleep(2500);
    const coinChunk = await page.evalJs<string[]>(map3AssetsJs);
    s.coin = { mint: coinRoot.mint, bmCanvas: coin, chunk: coinChunk, m3: await page.evalJs<boolean>(`!!document.querySelector(".m3")`) };
    check(coin, "/c/<mint>#tree rendered no .bm-canvas");
    check(coinChunk.length === 0, `/c/<mint> loaded the map3 chunk: ${coinChunk.join(", ")}`);
    s.shotCoin = await shot(page, "o-coin-tree.png");
    await page.navigate(BASE + u("/embed/map"));
    const emb = await page.waitFor(`!!document.querySelector(".bm-canvas")`, 60_000, "the embed map").then(() => true, () => false);
    await sleep(2500);
    const embChunk = await page.evalJs<string[]>(map3AssetsJs);
    s.embed = { bmCanvas: emb, chunk: embChunk };
    check(emb, "/embed/map rendered no .bm-canvas");
    check(embChunk.length === 0, `/embed/map loaded the map3 chunk: ${embChunk.join(", ")}`);
    s.shotEmbed = await shot(page, "o-embed-map.png");
  });
} catch (e) {
  fails.push(`crashed: ${(e as Error).message}`);
} finally {
  // ---------------------------------------------------------------- (p)
  const errors = pages.flatMap((p) => p.errors);
  const netErrors = pages.flatMap((p) => p.netErrors);
  if (want("p")) {
    sections.p = { consoleErrors: errors.length, ok: errors.length === 0 };
    if (errors.length) fails.push(`(p) ${errors.length} console error(s): ${errors.slice(0, 4).join(" | ")}`);
  }
  result.sections = sections;
  result.consoleErrors = errors;
  result.networkErrors = netErrors;
  result.warnings = pages.flatMap((p) => p.warnings).slice(0, 40);
  result.notes = notes;
  result.failures = fails;
  result.ok = fails.length === 0;
  const text = JSON.stringify(result, null, 2);
  try { writeFileSync(join(SHOTS, "map3-qa.json"), text); } catch { /* the shots dir is optional */ }
  console.log(text);
  for (const b of browsers) await b.close();
}
process.exit(fails.length ? 1 : 0);
