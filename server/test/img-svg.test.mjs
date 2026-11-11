// SVG logos (2026-11-11, IMG_TYPE_RULE 2): the image proxy draws an SVG into a PNG original on the image worker
// (rasterizeSvg in lib/img-worker.mjs) and keeps and serves that PNG, never the SVG (it can script on our origin), so
// /api/img, its ?w= thumbnails and /api/logo-sheet work as for any PNG. Before resvg sees a document it is held to what a
// logo needs (SVG_ELEMENTS, local links only, no filter, SVG_MAX_DEPTH, SVG_MAX_ELEMENTS, plain entities): patterns,
// masks, filters, embedded images and the rest fail for good at once, whatever the spelling. Nothing outside the document
// is loaded or run, an oversized, broken or empty SVG fails for good, a drawing past its deadline ends the worker (never
// the event loop), and so does any job that grows the worker past WORKER_JOB_MAX_BYTES while it runs; resvg's own memory
// in a worker is capped (RESVG_MEMORY_MAX_BYTES) even while the event loop is blocked. At boot the SVG refusals an older
// rule recorded are forgotten once and asked again at once. Synthetic SVGs only (no third-party logo), stub fetch, temp
// dirs, in-memory sqlite: no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import zlib from "node:zlib";
import express from "express";
import * as meta from "../lib/meta.mjs"; // a namespace import: the new exports are looked up, so the file loads on an older lib too
import { decodePng } from "../lib/png.mjs";
import { Db } from "../lib/db.mjs";
import { isMint } from "../lib/api.mjs";
import { PublicKey } from "../lib/sdk.mjs";
import { renderLogo } from "../lib/agents/logo.mjs";

const { ImageCache, HostPacer, ImgWork, IMG_GONE_RETRY_MS, THUMB_RULE, GATEWAY_RULE } = meta;
const quiet = { info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (ok, ms = 10_000) => { const t0 = Date.now(); while (!ok()) { if (Date.now() - t0 > ms) return false; await sleep(20); } return true; };
const busy = (ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { /* the event loop is held */ } };
const MB = 2 ** 20;
const mint = (i) => { const b = Buffer.alloc(32, 7); b.writeUInt16BE(i, 30); return new PublicKey(b).toBase58(); };
const stock = (s) => `https://logos.example-broker.io/api/stock-logo/${s}`;
const cdn = (name) => `https://cdn.example-launchpad.io/${name}`;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const NS = 'xmlns="http://www.w3.org/2000/svg"';

// a flat logo the way stock-logo services draw one (18 x 18 user units, a red ground, a white disc), behind an XML
// declaration and a comment
const LOGO = `<?xml version="1.0" encoding="UTF-8"?>\n<!-- synthetic test logo -->\n<svg ${NS} width="18" height="18" viewBox="0 0 18 18"><path fill="#d02020" d="M0 0h18v18H0z"/><circle cx="9" cy="9" r="4" fill="#ffffff"/></svg>`;
const TALL = `<svg ${NS} viewBox="0 0 10 20"><rect width="10" height="20" fill="#2040d0"/></svg>`;
const RECT = `<rect width="10" height="10" fill="#d02020"/>`;
// what may stay in a logo but must neither run nor load anything: an event handler, a stylesheet import (beside the fill
// rule it sets), editor metadata in other namespaces (Inkscape's), a title, a local <use>. Drawn: green, all over.
const INERT = `<svg ${NS} xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" width="20" height="20" onload="fetch('https://evil.example/onload')">
<title>logo</title>
<metadata><rdf:RDF><rdf:Description rdf:about="https://evil.example/meta"/></rdf:RDF></metadata>
<sodipodi:namedview pagecolor="#ffffff"/>
<style>@import url(https://evil.example/x.css); .bg { fill: #20a040 }</style>
<defs><rect id="bg" class="bg" width="20" height="20"/></defs>
<use xlink:href="#bg"/>
</svg>`;
// an Illustrator export declares its namespaces as entities: harmless, drawn
const ILLUSTRATOR = `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [\n\t<!ENTITY ns_svg "http://www.w3.org/2000/svg">\n\t<!ENTITY ns_xlink "http://www.w3.org/1999/xlink">\n]>\n<svg version="1.1" xmlns="&ns_svg;" xmlns:xlink="&ns_xlink;" width="10" height="10">${RECT}</svg>`;
const LAUGHS = `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaaaaaaaa">${"bcdefghi".split("").map((c, i) => `<!ENTITY ${c} "${`&${"abcdefghi"[i]};`.repeat(10)}">`).join("")}]><svg ${NS} width="10" height="10"><desc>&i;</desc>${RECT}</svg>`;
// 50 KB referenced 20k times: 1 GB of text from a 110 KB file
const QUADRATIC = `<!DOCTYPE svg [<!ENTITY a "${"a".repeat(50_000)}">]><svg ${NS} width="10" height="10"><desc>${"&a;".repeat(20_000)}</desc>${RECT}</svg>`;
const EXTERNAL = `<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///C:/Windows/win.ini">]><svg ${NS} width="10" height="10"><desc>&x;</desc>${RECT}</svg>`;
const PARAMETER = `<!DOCTYPE svg [<!ENTITY % p "<!ENTITY x 'y'>"> %p;]><svg ${NS} width="10" height="10"><desc>&x;</desc>${RECT}</svg>`;
// two nested pattern tiles of 22000 user units, 0.4 KB: resvg allocated a pixmap per tile, ~3.7 GB in all (review S1)
const tile = (id, s, fill) => `<pattern id="${id}" width="${s}" height="${s}" patternUnits="userSpaceOnUse"><rect width="10" height="10" fill="${fill}"/></pattern>`;
const PATTERN_BOMB = `<svg ${NS} width="256" height="256">${tile("q", 22000, "#c33")}${tile("p", 22000, "url(#q)")}<rect width="256" height="256" fill="url(#p)"/></svg>`;
// a stroked path of 20k random segments: allowed, and resvg takes seconds over it (measured 2026-11-11: 2.2 s, 32 MB)
const SLOW = (() => { let s = 1, d = "M5 5"; const r = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff * 10).toFixed(2); for (let i = 0; i < 20_000; i++) d += `L${r()} ${r()}`; return `<svg ${NS} width="10" height="10"><path d="${d}" fill="none" stroke="#c33" stroke-width="3" stroke-linejoin="round"/></svg>`; })();
// 30 nested opacity groups around a rect far past the canvas: allowed (depth 32 with the root and the rect), and each
// group is a layer resvg allocates (measured: ~90 MB)
const LAYERS = `<svg ${NS} width="18" height="18" viewBox="0 0 18 18">${'<g opacity=".9">'.repeat(30)}<rect x="-750" y="-750" width="1500" height="1500" fill="#c33"/>${"</g>".repeat(30)}</svg>`;

/** A 1-bit grayscale PNG of n x n px: a few KB that resvg (and so a thumbnail) decodes whole into RGBA (8000 px: ~300 MB). */
function bitPng(n) {
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return ~c >>> 0; };
  const chunk = (type, data) => { const td = Buffer.concat([Buffer.from(type, "latin1"), data]), out = Buffer.alloc(8 + data.length + 4); out.writeUInt32BE(data.length, 0); td.copy(out, 4); out.writeUInt32BE(crc(td), 8 + data.length); return out; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 1; ihdr[9] = 0;
  const stride = 1 + Math.ceil(n / 8), raw = Buffer.alloc(stride * n, 0x55);
  for (let y = 0; y < n; y++) raw[y * stride] = 0;
  return Buffer.concat([PNG_SIG, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
/** `{ value, error, rise }`: what `fn` gave and how far this process's RSS rose above its start meanwhile (MB, sampled every 5 ms). */
async function peakRise(fn) {
  const base = process.memoryUsage.rss();
  let peak = base;
  const s = setInterval(() => { peak = Math.max(peak, process.memoryUsage.rss()); }, 5);
  try { return { value: await fn(), rise: (Math.max(peak, process.memoryUsage.rss()) - base) / MB }; }
  catch (error) { return { error, rise: (Math.max(peak, process.memoryUsage.rss()) - base) / MB }; }
  finally { clearInterval(s); }
}

const svgResponse = (body, type = "image/svg+xml", headers = {}) => new Response(body, { headers: { "content-type": type, ...headers } });
function makeCache({ fetchImpl, work, store = null, dir = mkdtempSync(join(tmpdir(), "spore-svg-")), log = quiet } = {}) {
  const own = !work;
  work ??= new ImgWork({ log: quiet });
  const mk = () => new ImageCache(dir, { pacer: new HostPacer({ fetchImpl, sleep: async () => {} }), concurrency: 8, work, store, log });
  return { dir, work, mk, cache: mk(), done: () => { if (own) work.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function serve(cache, imageOf = () => null) {
  const app = express();
  app.get("/api/img", cache.handler());
  app.get("/api/logo-sheet", cache.sheetHandler({ imageOf, isMint }));
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = async (path) => { const r = await fetch(`${base}${path}`); return { status: r.status, headers: r.headers, body: Buffer.from(await r.arrayBuffer()) }; };
  return { get, close: () => new Promise((r) => srv.close(r)) };
}
const rgbaAt = (im, x, y) => { const i = (y * im.w + x) * 4; return [...im.rgba.subarray(i, i + 4)]; };
const near = (a, b, tol = 3) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);
/** The originals on disk (not a thumbnail, a sidecar or a temp file). */
const originals = (dir) => readdirSync(dir).filter((n) => !n.includes(".")).map((n) => readFileSync(join(dir, n)));

test("an SVG logo becomes a PNG original: /api/img serves it as image/png (never the SVG), 256 px keeping its aspect, ?w=64 a thumbnail, and its logo-sheet cell is present; one sniffed under another type too", async () => {
  const calls = [];
  const bodies = { [stock("AAA")]: [LOGO, "image/svg+xml"], [stock("TALL")]: [TALL, "image/svg+xml; charset=utf-8"], [cdn("raw.svg")]: [LOGO, "text/plain"], [cdn("blob")]: [LOGO, "application/octet-stream"] };
  const fetchImpl = async (u) => { calls.push(u); const [b, t] = bodies[u] ?? ["", "text/plain"]; return svgResponse(b, t); };
  const { cache, dir, done } = makeCache({ fetchImpl });
  const mints = { [mint(1)]: stock("AAA"), [mint(2)]: stock("TALL") };
  const { get, close } = await serve(cache, (m) => mints[m] ?? null);
  try {
    const r = await get(`/api/img?u=${encodeURIComponent(stock("AAA"))}`);
    assert.equal(r.status, 200, "an SVG logo is served (it was refused: not an image: image/svg+xml)");
    assert.equal(r.headers.get("content-type"), "image/png");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(r.body.subarray(0, 8), PNG_SIG);
    assert.ok(!r.body.includes("<svg"), "no SVG bytes on the wire");
    const im = decodePng(r.body);
    assert.deepEqual([im.w, im.h], [256, 256], "fitted into 256 x 256");
    assert.ok(near(rgbaAt(im, 4, 4), [208, 32, 32, 255]), `the red ground: ${rgbaAt(im, 4, 4)}`);
    assert.ok(near(rgbaAt(im, 128, 128), [255, 255, 255, 255]), `the white disc: ${rgbaAt(im, 128, 128)}`);
    for (const bytes of originals(dir)) { assert.deepEqual(bytes.subarray(0, 8), PNG_SIG, "the original on disk is the PNG"); assert.ok(!bytes.includes("<svg")); }
    assert.equal(cache.stats.svgDrawn, 1);
    const t = await get(`/api/img?u=${encodeURIComponent(stock("AAA"))}&w=64`);
    assert.equal(t.status, 200); assert.equal(t.headers.get("x-img-thumb"), "64"); assert.equal(t.headers.get("content-type"), "image/png");
    const ti = decodePng(t.body);
    assert.deepEqual([ti.w, ti.h], [64, 64]);
    assert.ok(near(rgbaAt(ti, 1, 1), [208, 32, 32, 255]) && near(rgbaAt(ti, 32, 32), [255, 255, 255, 255]), "the thumbnail of the drawn logo");
    // a sheet: the warm cell at once; the tall logo, never asked before, lands within a few asks (a cold cell may be pending)
    let s = null;
    const deadline = Date.now() + 10_000;
    do { s = await get(`/api/logo-sheet?w=64&m=${mint(1)},${mint(2)}&f=png`); if (s.headers.get("x-sheet") === "03") break; await sleep(50); } while (Date.now() < deadline);
    assert.equal(s.status, 200);
    assert.equal(s.headers.get("x-sheet"), "03", "both cells present");
    assert.equal(s.headers.get("x-sheet-dead"), "00");
    const sheet = decodePng(s.body);
    assert.ok(near(rgbaAt(sheet, 2, 2), [208, 32, 32, 255]), "cell 0: the red logo");
    assert.ok(near(rgbaAt(sheet, 64 + 32, 32), [32, 64, 208, 255]), "cell 1: the blue tall logo");
    const tall = decodePng(readFileSync((await cache.get(stock("TALL"))).file));
    assert.deepEqual([tall.w, tall.h], [128, 256], "a tall logo is fitted by its height");
    // the type a host declares does not decide: plain text (raw file hosts) and octet-stream are sniffed as SVG
    for (const u of [cdn("raw.svg"), cdn("blob")]) {
      const hit = await cache.get(u);
      assert.ok(hit, u); assert.equal(hit.type, "image/png", u);
      assert.deepEqual(readFileSync(hit.file).subarray(0, 8), PNG_SIG, u);
    }
    assert.equal(calls.filter((u) => u === stock("AAA")).length, 1, "drawn once, then served from disk");
  } finally { await close(); done(); }
});

test("what a logo may hold and resvg never acts on (an event handler, a stylesheet import, editor metadata, a local <use>) is drawn without anything run or fetched; logo constructs from the usual editors draw; the stored and served bytes are a PNG", async () => {
  const calls = [];
  const deep = `<svg ${NS} width="10" height="10">${"<g>".repeat(30)}${RECT}${"</g>".repeat(30)}</svg>`; // 32 deep with the root and the rect
  const allowed = {
    INERT,
    deep,
    prefixed: `<svg:svg xmlns:svg="http://www.w3.org/2000/svg" width="10" height="10"><svg:g><svg:rect width="10" height="10" fill="#d02020"/></svg:g></svg:svg>`,
    kit: `<svg ${NS} xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10"><defs><linearGradient id="a"><stop offset="0" stop-color="#d02020"/><stop offset="1" stop-color="#d02020"/></linearGradient><linearGradient id="b" xlink:href="#a"/><clipPath id="c"><rect width="10" height="10"/></clipPath><symbol id="s"><circle cx="5" cy="5" r="5"/></symbol></defs><switch><g clip-path="url(#c)"><rect width="10" height="10" fill="url(#b)"/><ellipse cx="5" cy="5" rx="1" ry="1" fill="#d02020"/><line x1="0" y1="0" x2="1" y2="1"/><polyline points="0,0 1,1"/><polygon points="0,0 1,0 1,1" fill="#d02020"/></g></switch><text x="1" y="9" font-size="2" fill="#d02020"><tspan>ok</tspan></text></svg>`,
  };
  const fetchImpl = async (u) => { calls.push(u); const b = allowed[u.split("/").pop()]; return b ? svgResponse(b) : new Response("", { status: 404 }); };
  const { cache, dir, done } = makeCache({ fetchImpl });
  const { get, close } = await serve(cache);
  try {
    const r = await get(`/api/img?u=${encodeURIComponent(stock("INERT"))}`);
    assert.equal(r.status, 200, "drawn without what it must not do");
    assert.equal(r.headers.get("content-type"), "image/png");
    await sleep(50);
    assert.deepEqual(calls, [stock("INERT")], "only the logo itself was fetched: no stylesheet, metadata link or script");
    const im = decodePng(r.body);
    for (const [x, y] of [[20, 20], [200, 64], [64, 200], [230, 230]]) assert.ok(near(rgbaAt(im, x, y), [32, 160, 64, 255]), `green at ${x},${y} (${rgbaAt(im, x, y)})`);
    for (const bytes of [r.body, ...originals(dir)]) {
      assert.deepEqual(bytes.subarray(0, 8), PNG_SIG);
      for (const s of ["<svg", "fetch(", "onload", "evil.example", "@import"]) assert.ok(!bytes.includes(s), `no "${s}" in what is kept or served`);
    }
    for (const name of ["deep", "prefixed", "kit"]) {
      const hit = await cache.get(stock(name));
      assert.ok(hit, `${name}: drawn (${cache.failureOf(stock(name))?.error})`);
      assert.ok(near(rgbaAt(decodePng(readFileSync(hit.file)), 128, 128), [208, 32, 32, 255]), name);
    }
  } finally { await close(); done(); }
});

test("held to what a logo needs before resvg sees it: patterns, masks, filters (elements, attributes, CSS, behind an entity), embedded images and nested SVGs (whatever the spelling: a quote in the fragment, an entity, a character reference), scripts, foreignObject, outside links, deep or huge documents fail for good at once; nothing is fetched, no worker is ended", async () => {
  const PNG_HEAD = Buffer.concat([PNG_SIG, Buffer.from([0, 0, 0, 13]), Buffer.from("IHDR"), Buffer.from([0, 0, 0x13, 0x88, 0, 0, 0x13, 0x88, 8, 6, 0, 0, 0]), Buffer.alloc(4)]).toString("base64"); // claims 5000 x 5000
  const NESTED = Buffer.from(`<svg ${NS} width="10" height="10">${RECT}</svg>`).toString("base64");
  const doc = (body, prolog = "") => `${prolog}<svg ${NS} xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10">${RECT}${body}</svg>`;
  const uses = (el) => new RegExp(`^svg: it uses <${el}>$`);
  const cases = {
    pattern: [PATTERN_BOMB, uses("pattern")],
    mask: [doc(`<mask id="m"><rect width="10" height="10" fill="#fff"/></mask><rect width="10" height="10" mask="url(#m)"/>`), uses("mask")],
    filter: [doc(`<filter id="f"><feMorphology radius="100000"/></filter>`), uses("filter")],
    "fe-alone": [doc(`<feGaussianBlur stdDeviation="9"/>`), uses("feGaussianBlur")],
    "filter-attr": [doc(`<rect width="10" height="10" filter="blur(9)"/>`), /^svg: it uses a filter$/],
    "filter-style": [doc(`<rect width="10" height="10" style="fill:#fff; filter : drop-shadow(1px 1px 9px #000)"/>`), /^svg: it uses a filter$/],
    "filter-css": [doc(`<style>/* a */ rect { FILTER: blur(9px) }</style>`), /^svg: it uses a filter$/],
    "filter-entity": [doc(`<rect width="10" height="10" style="&f;"/>`, `<!DOCTYPE svg [<!ENTITY f "filter:blur(9px)">]>`), /^svg: it uses a filter$/],
    "filter-cdata": [doc(`<style><![CDATA[ rect { filter: blur(9px) } ]]></style>`), /^svg: it uses a filter$/],
    script: [doc(`<script>fetch("https://evil.example/script")</script>`), uses("script")],
    "image-external": [doc(`<image width="10" height="10" href="https://evil.example/pixel.png"/>`), uses("image")],
    "image-file": [doc(`<image width="10" height="10" xlink:href="file:///C:/Windows/win.ini"/>`), uses("image")],
    "image-data": [doc(`<image width="10" height="10" href="data:image/png;base64,${PNG_HEAD}"/>`), uses("image")],
    "image-quote-fragment": [doc(`<image width="10" height="10" href="data:image/png;base64,${PNG_HEAD}#'"/>`), uses("image")],
    "image-entity": [doc(`<image width="10" height="10" href="&d;:image/png;base64,${PNG_HEAD}"/>`, `<!DOCTYPE svg [<!ENTITY d "data">]>`), uses("image")],
    "image-redos": [doc(`<image width="10" height="10" href="data:${"a".repeat(100_000)}"/>`), uses("image")],
    "nested-quote-fragment": [doc(`<image width="10" height="10" href="data:image/svg+xml;base64,${NESTED}#'"/>`), uses("image")],
    "use-external": [doc(`<use href="https://evil.example/sprite.svg#x"/>`), /^svg: it links outside itself$/],
    "use-data": [doc(`<use xlink:href="data:image/svg+xml;base64,${NESTED}#x"/>`), /^svg: it links outside itself$/],
    "use-entity": [doc(`<use href="&e;"/>`, `<!DOCTYPE svg [<!ENTITY e "data:image/svg+xml;base64,${NESTED}">]>`), /^svg: it links outside itself$/],
    "use-charref": [doc(`<use href="&#100;ata:image/svg+xml;base64,${NESTED}"/>`), /^svg: it links outside itself$/],
    "use-hexref": [doc(`<use href="&#x64;ata:image/svg+xml;base64,${NESTED}"/>`), /^svg: it links outside itself$/],
    foreignObject: [doc(`<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>`), uses("foreignObject")],
    "prefixed-pattern": [`<s:svg xmlns:s="http://www.w3.org/2000/svg" width="10" height="10"><s:pattern id="p" width="9" height="9"/></s:svg>`, uses("pattern")],
    "unprefixed-elsewhere": [doc(`<wrap xmlns="urn:x"><pattern/></wrap>`), uses("wrap")],
    deep: [`<svg ${NS} width="10" height="10">${"<g>".repeat(32)}${"</g>".repeat(32)}</svg>`, /^svg: it nests elements deeper than 32$/],
    huge: [`<svg ${NS} width="10" height="10">${'<rect width="1" height="1"/>'.repeat(10_000)}</svg>`, /^svg: it has over 10000 elements$/],
    "text-flood": [doc(`<text y="9"><tspan>${"W".repeat(1500)}</tspan>${"W".repeat(501)}</text>`), /^svg: it holds over 2000 characters of text$/],
    "text-entity": [doc(`<text y="9">&w;&w;</text>`, `<!DOCTYPE svg [<!ENTITY w "${"W".repeat(1500)}">]>`), /^svg: it holds over 2000 characters of text$/],
    "bad-reference": [doc(`<rect width="10" height="10" fill="&nope;"/>`), /^svg: not well-formed$/],
  };
  const calls = [];
  const fetchImpl = async (u) => { calls.push(u); const c = cases[u.split("/").pop()]; return c ? svgResponse(c[0]) : u.endsWith("/WARM") ? svgResponse(LOGO) : new Response("", { status: 404 }); };
  const { cache, work, done } = makeCache({ fetchImpl });
  try {
    assert.ok(await cache.get(stock("WARM")), "a logo draws (the worker starts here, not inside the first timed case)");
    for (const [name, [, why]] of Object.entries(cases)) {
      const t0 = Date.now();
      assert.equal(await cache.get(stock(name)), null, `${name}: not drawn`);
      const f = cache.failureOf(stock(name));
      assert.equal(f?.kind, "gone", `${name}: permanent (${f?.error})`);
      assert.match(f.error, why, name);
      assert.ok(Date.now() - t0 < 1000, `${name}: refused before resvg, not after a deadline (${Date.now() - t0} ms)`);
    }
    assert.deepEqual(calls.filter((u) => !u.startsWith(stock(""))), [], "nothing but the logos was fetched");
    assert.equal(work.stats.overtime, 0, "no drawing ran into its deadline"); assert.equal(work.stats.restarts, 0);
    assert.equal(cache.stats.svgDrawn, 1, "only the warm-up logo was drawn");
  } finally { done(); }
});

test("the 0.4 KB SVG of two nested 22000-unit pattern tiles (review S1: ~3.7 GB in resvg) is refused while this process's RSS stays within 64 MB", async () => {
  const { cache, done } = makeCache({ fetchImpl: async (u) => svgResponse(u.endsWith("BOMB") ? PATTERN_BOMB : LOGO) });
  try {
    assert.ok(await cache.get(stock("WARM")), "a logo draws (the worker is up)");
    assert.ok(PATTERN_BOMB.length < 450, `${PATTERN_BOMB.length} bytes`);
    const { value, rise } = await peakRise(() => cache.get(stock("BOMB")));
    assert.equal(value, null);
    assert.ok(rise < 64, `peak RSS rise ${rise.toFixed(0)} MB`);
    assert.match(cache.failureOf(stock("BOMB"))?.error ?? "", /^svg: it uses <pattern>$/);
  } finally { done(); }
});

test("entities: Illustrator's namespace entities are drawn; billion laughs, a quadratic blowup, an external and a parameter entity fail for good with a clear error, at once", async () => {
  const docs = { ILLUSTRATOR, LAUGHS, QUADRATIC, EXTERNAL, PARAMETER };
  const fetchImpl = async (u) => svgResponse(docs[u.split("/").pop()] ?? "");
  const { cache, done } = makeCache({ fetchImpl });
  try {
    const ok = await cache.get(stock("ILLUSTRATOR"));
    assert.ok(ok, "an Illustrator export is a logo");
    assert.ok(near(rgbaAt(decodePng(readFileSync(ok.file)), 128, 128), [208, 32, 32, 255]));
    for (const [name, why] of [["LAUGHS", /^svg: an entity holds references or markup$/], ["QUADRATIC", /^svg: entities expand past 64 KB$/], ["EXTERNAL", /^svg: external or parameter entities$/], ["PARAMETER", /^svg: external or parameter entities$/]]) {
      const t0 = Date.now();
      assert.equal(await cache.get(stock(name)), null, name);
      const f = cache.failureOf(stock(name));
      assert.equal(f?.kind, "gone", name);
      assert.match(f.error, why, name);
      assert.ok(Date.now() - t0 < 1000, `${name}: refused before resvg, not after a deadline (${Date.now() - t0} ms)`);
    }
    assert.equal(cache.work.stats.overtime, 0); assert.equal(cache.work.stats.restarts, 0);
  } finally { done(); }
});

test("oversized, broken, empty or nested SVGs fail for good (an hour first, as any permanent failure): /api/img 404 and a dead sheet cell", async () => {
  const pad = (n) => `<svg ${NS} width="10" height="10"><!--${"x".repeat(n)}-->${RECT}</svg>`;
  const nested = Buffer.from(`<svg ${NS} width="10" height="10">${RECT}</svg>`).toString("base64");
  // a png header claiming 20000 x 20000 (resvg would decode it whole: GBs), embedded as a data: url
  const BOMB_PNG = Buffer.concat([PNG_SIG, Buffer.from([0, 0, 0, 13]), Buffer.from("IHDR"), Buffer.from([0, 0, 0x4e, 0x20, 0, 0, 0x4e, 0x20, 8, 6, 0, 0, 0]), Buffer.alloc(4)]);
  const cases = {
    "big-declared": [() => svgResponse(pad(MB), "image/svg+xml", { "content-length": String(MB + 200) }), /^svg: over 1024 KB$/],
    "big-streamed": [() => svgResponse(pad(MB)), /^svg: over 1024 KB$/],
    "big-sniffed": [() => svgResponse(pad(1.5 * MB), "application/octet-stream"), /^svg: over 1024 KB$/],
    unclosed: [() => svgResponse(`<svg ${NS} width="10" height="10"><rect width="10" height="10"`), /^svg: not well-formed$/],
    "no-namespace": [() => svgResponse(`<svg width="10" height="10">${RECT}</svg>`), /^svg: cannot be drawn \(/],
    empty: [() => svgResponse(`<svg ${NS} width="10" height="10"><rect width="10" height="10" fill="none"/></svg>`), /^svg: draws nothing$/],
    "zero-size": [() => svgResponse(`<svg ${NS} width="100000" height="1">${RECT}</svg>`), /^svg: cannot be drawn \(/],
    "html-as-svg": [() => svgResponse("<!doctype html><html><body><svg></svg></body></html>"), /^svg: not an svg document$/],
    "nested-svg": [() => svgResponse(`<svg ${NS} width="10" height="10"><image width="10" height="10" href="data:image/svg+xml;base64,${nested}"/></svg>`), /^svg: it uses <image>$/],
    "nested-untyped": [() => svgResponse(`<svg ${NS} width="10" height="10"><image width="10" height="10" href="data:,%3Csvg%2F%3E"/></svg>`), /^svg: it uses <image>$/],
    "png-bomb": [() => svgResponse(`<svg ${NS} width="10" height="10"><image width="10" height="10" href="data:image/png;base64,${BOMB_PNG.toString("base64")}"/></svg>`), /^svg: it uses <image>$/],
  };
  const fetchImpl = async (u) => cases[u.split("/").pop()]?.[0]() ?? new Response("", { status: 404 });
  const { cache, done } = makeCache({ fetchImpl });
  const names = Object.keys(cases), mints = Object.fromEntries(names.map((n, i) => [mint(100 + i), stock(n)]));
  const { get, close } = await serve(cache, (m) => mints[m] ?? null);
  try {
    for (const [name, [, why]] of Object.entries(cases)) {
      const r = await get(`/api/img?u=${encodeURIComponent(stock(name))}`);
      assert.equal(r.status, 404, name);
      const f = cache.failureOf(stock(name));
      assert.equal(f?.kind, "gone", `${name}: permanent`);
      assert.match(f.error, why, name);
      assert.equal(f.retryAt - f.at, IMG_GONE_RETRY_MS[0], `${name}: retried after an hour, then a day, then weekly`);
    }
    const s = await get(`/api/logo-sheet?w=64&m=${Object.keys(mints).join(",")}`);
    assert.equal(s.headers.get("x-sheet-dead"), meta.hexBits(names.map(() => 1)), "every cell dead");
    assert.equal(s.headers.get("x-sheet"), meta.hexBits(names.map(() => 0)));
    assert.equal(cache.stats.svgDrawn, 0);
  } finally { await close(); done(); }
});

test("a drawing past its deadline fails for good and ends the worker, not the loop: the next logo draws on a fresh worker, no restart is counted; without a worker an SVG is never drawn inline (a temporary failure)", async () => {
  const work = new ImgWork({ log: quiet, svgMaxMs: 300 });
  const fetchImpl = async (u) => svgResponse(u.endsWith("SLOW") ? SLOW : LOGO);
  const { cache, done } = makeCache({ fetchImpl, work });
  const inline = new ImgWork({ inline: true, log: quiet });
  const c2 = makeCache({ fetchImpl, work: inline });
  try {
    assert.ok(await cache.get(stock("FIRST")), "a logo draws");
    let ticks = 0;
    const beat = setInterval(() => ticks++, 25);
    const t0 = Date.now();
    assert.equal(await cache.get(stock("SLOW")), null);
    const ms = Date.now() - t0;
    clearInterval(beat);
    const f = cache.failureOf(stock("SLOW"));
    assert.equal(f?.kind, "gone");
    assert.equal(f.error, "svg: drawing it took over 300 ms");
    assert.ok(ms < 3000, `stopped near its deadline (${ms} ms)`);
    assert.ok(ticks >= Math.floor(ms / 25) / 3, `the event loop kept running meanwhile (${ticks} beats in ${ms} ms)`);
    assert.equal(work.stats.overtime, 1); assert.equal(work.stats.restarts, 0, "an ended worker is no crash"); assert.equal(work.stats.inline, 0);
    const next = await cache.get(stock("NEXT"));
    assert.ok(next, "the next logo draws on a fresh worker");
    assert.equal(next.type, "image/png");
    // no worker (one that cannot start, or keeps dying): never drawn on the loop, asked again in a minute
    assert.equal(await c2.cache.get(stock("INLINE")), null);
    const g = c2.cache.failureOf(stock("INLINE"));
    assert.equal(g?.kind, "temp");
    assert.match(g.error, /^svg: no image worker/);
  } finally { work.close(); inline.close(); done(); c2.done(); }
});

test("a drawing that finished in time is kept when the event loop was held past the deadline meanwhile (review I1): its answer, already waiting, wins over the timer", async () => {
  const work = new ImgWork({ log: quiet, svgMaxMs: 300 });
  try {
    assert.deepEqual((await work.svg({ bytes: Buffer.from(LOGO) })).subarray(0, 8), PNG_SIG, "warm");
    // after the worker took the job up (its timer is armed), an I/O or immediate callback holds the loop past the deadline
    work.worker.on("message", (m) => { if (m.started) setImmediate(() => busy(800)); });
    const png = await work.svg({ bytes: Buffer.from(LOGO) });
    assert.deepEqual(png.subarray(0, 8), PNG_SIG, "drawn, not failed as overtime");
    assert.equal(work.stats.overtime, 0); assert.equal(work.stats.recycled, 0, "the healthy worker is kept");
    // a drawing that really runs long is still stopped
    await assert.rejects(work.svg({ bytes: Buffer.from(SLOW) }), (e) => e.overtime === true && e.message === "svg: drawing it took over 300 ms");
  } finally { work.close(); }
});

test("a job that grows the worker past its memory bound while it runs (review S1) ends the worker at once, whatever the job: a raster thumbnail fails, an SVG fails for good, peak RSS stays near the bound, and the next job runs on a fresh worker", async () => {
  const work = new ImgWork({ log: quiet, jobMaxBytes: 64 * MB });
  const bomb = bitPng(8000); // ~22 KB; decoded whole: ~300 MB
  const fetchImpl = async (u) => (u.endsWith("bomb.png") ? new Response(bomb, { headers: { "content-type": "image/png" } }) : svgResponse(u.endsWith("LAYERS") ? LAYERS : LOGO));
  const { cache, done } = makeCache({ fetchImpl, work });
  try {
    assert.ok(await cache.get(stock("WARM")), "warm");
    const t = await peakRise(() => work.thumb({ bytes: bomb, type: "image/png", w: 64 }));
    assert.ok(t.error, "the thumbnail is not made");
    assert.equal(t.error.memory, true);
    assert.equal(t.error.message, "thumb: it took over 64 MB of memory");
    assert.ok(t.rise < 160, `peak RSS rise ${t.rise.toFixed(0)} MB (unbounded: ~300)`);
    assert.equal(work.stats.overMemory, 1); assert.equal(work.stats.restarts, 0, "no crash"); assert.equal(work.stats.inline, 0);
    assert.ok(await cache.get(stock("NEXT")), "the next job runs on a fresh worker");
    // through the cache: an SVG that passes every check but needs ~90 MB of layers fails for good
    const s = await peakRise(() => cache.get(stock("LAYERS")));
    assert.equal(s.value, null);
    assert.ok(s.rise < 160, `peak RSS rise ${s.rise.toFixed(0)} MB`);
    const f = cache.failureOf(stock("LAYERS"));
    assert.equal(f?.kind, "gone");
    assert.equal(f.error, "svg: drawing it took over 64 MB of memory");
    // a raster logo's thumbnail: "cannot be drawn", the original is still served
    const hit = await cache.get(cdn("bomb.png"));
    assert.ok(hit, "the original is kept");
    assert.equal(await cache.thumb(cdn("bomb.png"), hit, 64), null);
    assert.equal(cache.failureOf(cdn("bomb.png"))?.kind, "nothumb");
    assert.equal(work.stats.overMemory, 3); assert.equal(work.stats.restarts, 0);
  } finally { work.close(); done(); }
});

test("resvg's memory in a worker is capped (RESVG_MEMORY_MAX_BYTES): a job that needs more traps at the cap even while the event loop is held and nothing can watch it, and its worker is replaced", async () => {
  const work = new ImgWork({ log: quiet, jobMaxBytes: 0, resvgMaxBytes: 96 * MB }); // the watchdog off: only the cap holds
  const bomb = bitPng(8000);
  try {
    assert.deepEqual((await work.svg({ bytes: Buffer.from(LOGO) })).subarray(0, 8), PNG_SIG, "warm");
    const base = process.memoryUsage.rss();
    let peak = base;
    const job = work.thumb({ bytes: bomb, type: "image/png", w: 64 }).then(() => null, (e) => e);
    const t0 = Date.now();
    while (Date.now() - t0 < 1200) peak = Math.max(peak, process.memoryUsage.rss()); // the loop is held: no timer runs
    const err = await job;
    assert.ok(err, "the thumbnail is not made");
    assert.ok((peak - base) / MB < 150, `peak RSS rise ${((peak - base) / MB).toFixed(0)} MB (uncapped: ~300)`);
    await until(() => work.stats.recycled >= 1, 3000);
    assert.equal(work.stats.recycled, 1, "the trapped worker is replaced"); assert.equal(work.stats.restarts, 0);
    assert.deepEqual((await work.svg({ bytes: Buffer.from(LOGO) })).subarray(0, 8), PNG_SIG, "a fresh worker draws");
  } finally { work.close(); }
});

test("a worker whose wasm memory grew past WORKER_RECYCLE_BYTES (~10x what a logo leaves) is replaced once idle: wasm memory never shrinks (review S2); logos leave it alone", async () => {
  const work = new ImgWork({ log: quiet });
  try {
    for (let i = 0; i < 3; i++) assert.deepEqual((await work.svg({ bytes: Buffer.from(LOGO) })).subarray(0, 8), PNG_SIG);
    assert.equal(work.stats.recycled, 0, "a logo leaves ~10 MB");
    const bytes = bitPng(6000), base = process.memoryUsage.rss();
    const png = await work.thumb({ bytes, type: "image/png", w: 64 }); // ~170 MB: under the job bound, over the recycle bound
    assert.deepEqual(png.subarray(0, 8), PNG_SIG, "drawn");
    assert.equal(work.stats.recycled, 1, "then replaced (a 512 MB bound kept ~170 MB for good)");
    assert.ok(await until(() => process.memoryUsage.rss() - base < 64 * MB, 5000), `its memory is given back (${((process.memoryUsage.rss() - base) / MB).toFixed(0)} MB over)`);
    assert.equal(work.stats.restarts, 0);
    assert.ok(meta.WORKER_RECYCLE_BYTES <= 128 * MB, `recycle bound ${meta.WORKER_RECYCLE_BYTES / MB} MB`);
  } finally { work.close(); }
});

test("a worker whose wasm memory grew past its bound is replaced once idle, whatever the job; the jobs it holds finish, no restart is counted, and /api/health (snapshot) shows the worker's counters and the log says why (review I3)", async () => {
  const logs = [];
  const work = new ImgWork({ log: { ...quiet, info: (m) => logs.push(m) }, recycleBytes: 1 }); // every job leaves more than a byte: each answer asks for a fresh worker
  const png = await renderLogo({ symbol: "R", palette: ["#d02020", "#112233", "#ffffff"], seed: "recycle" });
  const { cache, done } = makeCache({ fetchImpl: async () => svgResponse(LOGO), work });
  try {
    const a = await work.thumb({ bytes: png, type: "image/png", w: 64 });
    assert.deepEqual(a.subarray(0, 8), PNG_SIG);
    assert.equal(work.stats.recycled, 1, "replaced after its job");
    const [b, c] = await Promise.all([work.thumb({ bytes: png, type: "image/png", w: 128 }), work.card({ svg: `<svg ${NS} width="20" height="10">${RECT}</svg>` })]);
    assert.deepEqual(b.subarray(0, 8), PNG_SIG, "a job queued behind the answer that asked for a fresh worker still finishes");
    assert.deepEqual(c.subarray(0, 8), PNG_SIG);
    assert.equal(work.stats.recycled, 2, "that worker too, once it held nothing");
    assert.equal(work.stats.restarts, 0, "a replaced worker is no crash"); assert.equal(work.stats.inline, 0);
    assert.ok(await cache.get(stock("AAA")));
    const snap = cache.snapshot();
    assert.ok(snap.work, "the worker's counters are in the health snapshot");
    for (const k of ["jobs", "failed", "restarts", "inline", "overtime", "overMemory", "recycled"]) assert.equal(typeof snap.work[k], "number", k);
    assert.equal(snap.work.recycled, 3);
    assert.ok(logs.some((m) => /^img work: worker replaced \(its wasm memory is over /.test(m)), logs.join("\n"));
  } finally { work.close(); done(); }
});

test("a logo sent with Content-Encoding gzip, deflate or br (a stored encoding, whatever we asked) is inflated within the size cap before the sniff; a body the fetch layer already decoded is used as it is (review I5)", async () => {
  const png = await renderLogo({ symbol: "Z", palette: ["#d02020", "#112233", "#ffffff"], seed: "gzip" });
  const huge = Buffer.from(`<svg ${NS} width="10" height="10"><!--${"x".repeat(2 * MB)}-->${RECT}</svg>`);
  const bodies = {
    "gz.svg": [zlib.gzipSync(LOGO), "image/svg+xml", "gzip"],
    "xgz.svg": [zlib.gzipSync(LOGO), "image/svg+xml", "x-gzip"],
    "deflate.svg": [zlib.deflateSync(LOGO), "image/svg+xml", "deflate"],
    "raw-deflate.svg": [zlib.deflateRawSync(LOGO), "image/svg+xml", "deflate"],
    "br.svg": [zlib.brotliCompressSync(LOGO), "image/svg+xml", "br"],
    "gz.png": [zlib.gzipSync(png), "application/octet-stream", "gzip"],
    "decoded.svg": [Buffer.from(LOGO), "image/svg+xml", "gzip"],
    "decoded.png": [png, "image/png", "br"],
    "bomb.svg": [zlib.gzipSync(huge), "image/svg+xml", "gzip"],
    "bomb.png": [zlib.gzipSync(Buffer.concat([png, Buffer.alloc(5 * MB)])), "image/png", "gzip"],
  };
  const fetchImpl = async (u) => { const [b, type, enc] = bodies[u.split("/").pop()]; return new Response(b, { headers: { "content-type": type, "content-encoding": enc } }); };
  const { cache, done } = makeCache({ fetchImpl });
  try {
    for (const name of ["gz.svg", "xgz.svg", "deflate.svg", "raw-deflate.svg", "br.svg", "decoded.svg"]) {
      const hit = await cache.get(cdn(name));
      assert.ok(hit, `${name}: drawn (${cache.failureOf(cdn(name))?.error})`);
      assert.equal(hit.type, "image/png");
      assert.ok(near(rgbaAt(decodePng(readFileSync(hit.file)), 128, 128), [255, 255, 255, 255]), name);
    }
    for (const name of ["gz.png", "decoded.png"]) {
      const hit = await cache.get(cdn(name));
      assert.ok(hit, `${name}: served (${cache.failureOf(cdn(name))?.error})`);
      assert.deepEqual(readFileSync(hit.file), png, `${name}: the logo's own bytes`);
    }
    for (const [name, why] of [["bomb.svg", /^svg: over 1024 KB$/], ["bomb.png", /^too large$/]]) {
      assert.equal(await cache.get(cdn(name)), null, name);
      const f = cache.failureOf(cdn(name));
      assert.equal(f?.kind, "gone", name); assert.match(f.error, why, name);
    }
  } finally { done(); }
});

test("boot re-check (IMG_TYPE_RULE): the SVG, plain-text and XML refusals an older rule recorded are forgotten once and asked again at once; every other failure, svg-looking text elsewhere and later boots are untouched", async () => {
  const db = new Db(":memory:");
  db.kvSet("imgThumbRule", THUMB_RULE); db.kvSet("imgGatewayRule", GATEWAY_RULE); // those rules ran long ago
  const now = Date.now(), week = 7 * 24 * 3600_000;
  const row = (url, kind, error) => db.imgFailSet({ url, kind, error, attempts: 3, goneAttempts: kind === "gone" ? 3 : 0, at: now, retryAt: now + week });
  // what the old proxy recorded for an SVG: "not an image: <declared>" (svg in the declared type, or plain text / XML, which
  // it refused before the download: raw file hosts serve .svg so), or the sniff's "not a raster image (<declared>)"
  const svg = {
    [stock("AAA")]: "not an image: image/svg+xml", [stock("BBB")]: "not an image: image/svg+xml", ["https://arweave.net/SvgTxOne"]: "not an image: image/svg",
    [cdn("odd.svg")]: "not a raster image (application/svg+xml)", [cdn("raw/logo.svg")]: "not an image: text/plain", [cdn("feed/logo.xml")]: "not an image: text/xml",
  };
  const kept = {
    [cdn("page.png")]: ["gone", "not an image: text/html"], [cdn("x.css")]: ["gone", "not an image: text/css"], [cdn("x.avif")]: ["gone", "not a raster image (image/avif)"], [cdn("404.png")]: ["gone", "HTTP 404"],
    [cdn("busy.png")]: ["temp", "HTTP 503"], [cdn("bad.png")]: ["nothumb", "not drawable"], [cdn("big.png")]: ["gone", "too large"],
    [cdn("logo.svg")]: ["gone", "HTTP 404"], ["https://ipfs.io/ipfs/QmSvgGatewayRow"]: ["gone", "404 svg.example-gateway.io; 404 ipfs.io; 404 dweb.link"],
  };
  for (const [u, e] of Object.entries(svg)) row(u, "gone", e);
  for (const [u, [k, e]] of Object.entries(kept)) row(u, k, e);
  const calls = [];
  const fetchImpl = async (u) => { calls.push(u); return svgResponse(LOGO, u.includes("raw/") ? "text/plain" : "image/svg+xml"); };
  const logs = [];
  const { work, mk, cache: c, done } = makeCache({ fetchImpl, store: db, log: { ...quiet, info: (m) => logs.push(m) } });
  let c2 = null;
  try {
    assert.deepEqual(db.imgFailAll().map((f) => f.url).sort(), Object.keys(kept).sort(), "exactly those refusals are forgotten (sqlite)");
    for (const u of Object.keys(svg)) assert.equal(c.failureOf(u), null, `${u}: forgotten (memory)`);
    for (const u of Object.keys(kept)) assert.ok(c.failureOf(u), `${u}: kept`);
    assert.equal(db.kvGet("imgTypeRule"), meta.IMG_TYPE_RULE);
    assert.ok(logs.includes(`img: type rule ${meta.IMG_TYPE_RULE}: 6 logos refused by the old rule (SVG, plain text, XML) forgotten and asked again`), logs.join("\n"));
    // asked again at once (the first-sight queue), not when a visitor or the next warm pass gets to them
    assert.ok(await until(() => Object.keys(svg).every((u) => c.thumbOnDisk(u, 64))), "every forgotten logo drawn and thumbnailed");
    assert.deepEqual([...calls].sort(), Object.keys(svg).sort(), "each asked once, nothing else fetched");
    assert.deepEqual(db.imgFailAll().map((f) => f.url).sort(), Object.keys(kept).sort(), "no new failure");
    assert.equal(work.stats.restarts, 0);
    // once per rule, not once per boot
    row(stock("CCC"), "gone", "not an image: image/svg+xml");
    c2 = mk();
    await sleep(100);
    assert.ok(c2.failureOf(stock("CCC")), "a later boot keeps it");
    assert.ok(!calls.includes(stock("CCC")));
  } finally { c.close(); c2?.close(); done(); db.close(); }
});
