// WebP logos (most launchpad CDNs serve them) get real 64/128/256 px thumbnails: renderThumb decodes
// them with libwebp (wasm) and box-downsamples; GET /api/img?w= answers a PNG thumbnail with
// x-img-thumb like for png/jpeg; an undecodable webp still serves the original, an animated one is
// drawn from its first frame; warm() covers webp urls. Fixture: test/fixtures/logo.webp (64 x 64
// lossy, alpha). Stub fetch only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import { ImageCache, HostPacer, ImgWork, renderThumb } from "../lib/meta.mjs";
import { decodePng } from "../lib/png.mjs";
import { decodeWebp, firstFrameWebp } from "../lib/webp.mjs";
import { pngSize } from "../lib/agents/logo.mjs";

const WEBP = readFileSync(new URL("./fixtures/logo.webp", import.meta.url));
// RIFF....WEBP with no decodable frame: sniffed as webp, refused by the decoder
const STUB = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x20, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(24, 1)]);
const quiet = { info() {}, warn() {}, error() {} };

async function serve(cache) {
  const app = express();
  app.get("/api/img", cache.handler());
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

test("renderThumb: a webp becomes a w x w PNG with alpha at 64/128/256; the stub is null", async () => {
  const im = await decodeWebp(WEBP);
  assert.equal(im.width, 64); assert.equal(im.height, 64);
  for (const w of [64, 128, 256]) {
    const png = await renderThumb(WEBP, "image/webp", w);
    assert.ok(png, `w=${w}`);
    assert.deepEqual(pngSize(png), { width: w, height: w });
    const d = decodePng(png);
    const centre = d.rgba[((w / 2) * w + w / 2) * 4 + 3], corner = d.rgba[3];
    assert.equal(centre, 255, "opaque at the centre of the badge"); assert.equal(corner, 0, "transparent corner");
  }
  assert.equal(await renderThumb(STUB, "image/webp", 64), null);
  assert.equal(await renderThumb(WEBP, "image/webp", 100), null, "unknown size");
  assert.equal(await decodeWebp(STUB), null);
});

test("GET /api/img?w=64 on a webp source answers image/png + x-img-thumb; an undecodable webp serves the original", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-webp-"));
  const bodies = { "a.webp": WEBP, "stub.webp": STUB };
  let fetches = 0;
  const fetchImpl = async (url) => { fetches++; return new Response(bodies[url.split("/").pop()], { headers: { "content-type": "image/webp" } }); };
  const cache = new ImageCache(dir, { pacer: new HostPacer({ fetchImpl, sleep: async () => {} }), concurrency: 8, log: quiet });
  const { base, close } = await serve(cache);
  const get = async (name, w) => {
    const r = await fetch(`${base}/api/img?u=${encodeURIComponent(`https://ipfs.io/ipfs/Qm/${name}`)}${w == null ? "" : `&w=${w}`}`);
    return { status: r.status, type: r.headers.get("content-type"), thumb: r.headers.get("x-img-thumb"), cc: r.headers.get("cache-control"), body: Buffer.from(await r.arrayBuffer()) };
  };
  try {
    const t = await get("a.webp", 64);
    assert.equal(t.status, 200); assert.equal(t.type, "image/png"); assert.equal(t.thumb, "64");
    assert.match(t.cc, /max-age=604800/);
    assert.deepEqual(pngSize(t.body), { width: 64, height: 64 });
    assert.ok(existsSync(cache.thumbPath("https://ipfs.io/ipfs/Qm/a.webp", 64)), "thumbnail cached beside the original");
    const big = await get("a.webp", 256);
    assert.equal(big.thumb, "256"); assert.deepEqual(pngSize(big.body), { width: 256, height: 256 });
    const orig = await get("a.webp");
    assert.equal(orig.type, "image/webp"); assert.equal(orig.thumb, null); assert.deepEqual(orig.body, WEBP, "no w: the original webp");
    const stub = await get("stub.webp", 64);
    assert.equal(stub.status, 200); assert.equal(stub.type, "image/webp"); assert.equal(stub.thumb, null); assert.deepEqual(stub.body, STUB, "undecodable: the original");
    assert.equal(cache.stats.thumbFailed, 1);
    assert.equal(fetches, 2, "each original fetched once");
  } finally { await close(); rmSync(dir, { recursive: true, force: true }); cache.work.close(); }
});

test("warm() makes webp thumbnails too, through the worker or inline alike", async () => {
  for (const inline of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), "spore-webp-warm-"));
    const fetchImpl = async () => new Response(WEBP, { headers: { "content-type": "application/octet-stream" } });
    const work = new ImgWork({ inline, log: quiet });
    const cache = new ImageCache(dir, { pacer: new HostPacer({ fetchImpl, sleep: async () => {} }), log: quiet, work });
    try {
      const urls = ["https://ipfs.io/ipfs/Qm/w1.webp", "https://ipfs.io/ipfs/Qm/w2.webp"];
      { const r = await cache.warm(urls, 64, 2); assert.deepEqual({ n: r.n, ok: r.ok, failed: r.failed }, { n: 2, ok: 2, failed: 0 }, `inline=${inline}`); }
      for (const u of urls) assert.deepEqual(pngSize(readFileSync(cache.thumbPath(u, 64))), { width: 64, height: 64 });
      assert.equal(cache.stats.thumbs, 2);
      { const r = await cache.warm(urls, 64, 2); assert.deepEqual({ n: r.n, ok: r.ok, failed: r.failed }, { n: 2, ok: 2, failed: 0 }); }
      assert.equal(cache.stats.thumbs, 2, "warm thumbnails are not redrawn");
    } finally { work.close(); rmSync(dir, { recursive: true, force: true }); }
  }
});

test("an animated webp is drawn from its first frame (libwebp's still decoder refuses an animation); a still or truncated file has no first frame", async () => {
  // the fixture's frame (its ALPH + VP8 chunks after the VP8X header) as two ANMF frames of an animation
  const chunk = (id, body) => { const h = Buffer.alloc(8); h.write(id, 0, "latin1"); h.writeUInt32LE(body.length, 4); return Buffer.concat([h, body, Buffer.alloc(body.length & 1)]); };
  const frameData = WEBP.subarray(12 + 18);
  const anmf = Buffer.alloc(16); anmf.writeUIntLE(63, 6, 3); anmf.writeUIntLE(63, 9, 3); anmf.writeUIntLE(100, 12, 3); // 64 x 64 at (0, 0), 100 ms
  const vp8x = Buffer.alloc(10); vp8x[0] = 0x10 | 0x02; vp8x.writeUIntLE(63, 4, 3); vp8x.writeUIntLE(63, 7, 3); // alpha + animation, 64 x 64
  const body = Buffer.concat([Buffer.from("WEBP"), chunk("VP8X", vp8x), chunk("ANIM", Buffer.alloc(6)), chunk("ANMF", Buffer.concat([anmf, frameData])), chunk("ANMF", Buffer.concat([anmf, frameData]))]);
  const head = Buffer.alloc(8); head.write("RIFF", 0, "latin1"); head.writeUInt32LE(body.length, 4);
  const anim = Buffer.concat([head, body]);
  const still = await decodeWebp(WEBP), first = await decodeWebp(anim);
  assert.ok(first, "decoded");
  assert.equal(first.width, 64); assert.equal(first.height, 64);
  assert.equal(Buffer.compare(Buffer.from(first.data), Buffer.from(still.data)), 0, "the first frame, pixel for pixel");
  const png = await renderThumb(anim, "image/webp", 64);
  assert.deepEqual(pngSize(png), { width: 64, height: 64 });
  assert.equal(firstFrameWebp(WEBP), null, "a still webp is no animation");
  assert.equal(firstFrameWebp(anim.subarray(0, 200)), null, "truncated");
  assert.equal(await decodeWebp(anim.subarray(0, 200)), null);
  assert.equal(firstFrameWebp(STUB), null);
});
