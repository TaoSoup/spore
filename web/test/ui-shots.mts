// Page screenshots for design QA: every public route at desktop / tablet / phone widths, viewport and
// full-page, plus a JSON report of console errors, failed requests and the document's overflow. Built on
// the raw-CDP harness in map3-cdp.mts (no puppeteer).
//
//   node --import tsx test/ui-shots.mts --base http://127.0.0.1:5400 --out /tmp/shots [--pages /,/explore] \
//        [--viewports desktop,tablet,phone] [--full] [--reduced-motion] [--gpu metal|none] [--settle 2500]
//
// Output: <out>/<page-key>-<viewport>.png (viewport) and <out>/<page-key>-<viewport>-full.png (--full),
// <out>/report.json: per shot { url, viewport, errors, netErrors, docWidth, viewportWidth, overflowX, h }.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchChrome, sleep, type GpuMode } from "./map3-cdp.mts";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; };
const BASE = opt("--base", "http://127.0.0.1:5400").replace(/\/$/, "");
const OUT = opt("--out", join(process.env.SPORE_TMP ?? "/tmp", "spore-ui-shots"));
const FULL = args.includes("--full");
const REDUCED = args.includes("--reduced-motion");
const GPU = opt("--gpu", "metal") as GpuMode;
const SETTLE = Number(opt("--settle", "2500"));
const MAX_FULL_H = Number(opt("--max-h", "7000"));

const SPORE = "HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY";
const AGENT_ROOT = "FTcrJuck7yqAgQQzv9uud7MH2Av8S3mP9iveiXsutNeX";
const DEFAULT_PAGES: [string, string][] = [
  ["home", "/"], ["explore", "/explore"], ["map", "/map"], ["coin", `/c/${SPORE}`], ["launch", "/launch"],
  ["launch-child", `/launch?parent=${SPORE}`], ["agents", "/agents"], ["agent", `/agents/${AGENT_ROOT}`],
  ["claim", "/claim"], ["how", "/how"], ["fees", "/fees"], ["api", "/docs/api"], ["404", "/this-page-does-not-exist"],
];
const PAGES: [string, string][] = (() => {
  const p = opt("--pages", "");
  if (!p) return DEFAULT_PAGES;
  return p.split(",").map((path) => { const found = DEFAULT_PAGES.find(([, x]) => x === path); return found ?? [path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root", path]; });
})();
const VIEWPORTS: Record<string, { w: number; h: number; dpr: number; mobile: boolean }> = {
  desktop: { w: 1440, h: 900, dpr: 1, mobile: false },
  wide: { w: 1920, h: 1080, dpr: 1, mobile: false },
  tablet: { w: 834, h: 1112, dpr: 2, mobile: true },
  phone: { w: 390, h: 844, dpr: 2, mobile: true },
  narrow: { w: 320, h: 640, dpr: 2, mobile: true },
};
const WANT = opt("--viewports", "desktop,tablet,phone").split(",").filter((v) => VIEWPORTS[v]);

mkdirSync(OUT, { recursive: true });
const report: Record<string, unknown>[] = [];
const browser = await launchChrome({ gpu: GPU, width: 1440, height: 900, reducedMotion: REDUCED });
try {
  for (const vp of WANT) {
    const { w, h, dpr, mobile } = VIEWPORTS[vp];
    const page = await browser.newPage({ width: w, height: h, dpr, mobile, touch: mobile });
    if (REDUCED) await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    for (const [key, path] of PAGES) {
      const url = `${BASE}${path}`;
      page.errors.length = 0; page.netErrors.length = 0;
      try {
        await page.navigate(url, 45_000);
        await page.waitFor("!!document.querySelector('#root > *')", 20_000, "the app root").catch(() => null);
        await page.evalJs("document.fonts && document.fonts.ready.then(() => 1)", 8_000).catch(() => null);
        await sleep(SETTLE);
        const m = await page.evalJs<{ sw: number; cw: number; sh: number }>("({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, sh: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) })");
        const file = await page.shot(join(OUT, `${key}-${vp}.png`));
        let full: string | null = null;
        if (FULL && path !== "/map") {
          const fh = Math.min(m.sh, MAX_FULL_H);
          const r = await page.send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: fh, scale: 1 } });
          full = join(OUT, `${key}-${vp}-full.png`);
          writeFileSync(full, Buffer.from(r.data, "base64"));
        }
        report.push({ key, url, viewport: vp, width: w, file, full, docWidth: m.sw, viewportWidth: m.cw, overflowX: m.sw > m.cw + 1, docHeight: m.sh, errors: page.errors.slice(), netErrors: page.netErrors.slice() });
        console.log(`${key.padEnd(13)} ${vp.padEnd(8)} ${m.sw > m.cw + 1 ? `OVERFLOW ${m.sw}>${m.cw}` : "ok"}${page.errors.length ? ` errors=${page.errors.length}` : ""}${page.netErrors.length ? ` net=${page.netErrors.length}` : ""}`);
      } catch (e) {
        report.push({ key, url, viewport: vp, failed: String(e) });
        console.log(`${key.padEnd(13)} ${vp.padEnd(8)} FAILED ${String(e).slice(0, 120)}`);
      }
    }
    await page.close();
  }
} finally {
  await browser.close();
}
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log(`\n${report.length} shots in ${OUT}`);
