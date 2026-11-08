// GET /api/img?w=64|128|256: server-side logo thumbnails for the map (resvg-wasm), cached beside the original.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import { ImageCache, HostPacer, renderThumb } from "../lib/meta.mjs";
import { renderLogo, pngSize } from "../lib/agents/logo.mjs";

// a 40 x 24 JPEG (made once from a rendered logo)
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAKKADAAQAAAABAAAAGAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAGAAoAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMABAQEBAQEBgQEBgkGBgYJDAkJCQkMDwwMDAwMDxIPDw8PDw8SEhISEhISEhUVFRUVFRkZGRkZHBwcHBwcHBwcHP/bAEMBBAUFBwcHDAcHDB0UEBQdHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHf/dAAQAA//aAAwDAQACEQMRAD8A+6Na1zTPD9g+o6rMIYU49Sx7Ko6kn0rxU/FPxX4mu5LTwNohmRDgyy9B6bjlVX6Fs1q/GvRby/0a11O1y6WLMJVHZZMAPj2IwfrXS+E1s1+HMS+GhhxZPjy/v/adh3Z779/9O1JlUqftJ8rdlp+P6HKBvjiB5pi04nr5e/n6dcfrVdfin4i8OXcdn460R7UOcCaI7lP+71VvoGz7Vm3d/wCD7LwZCJYi2vSWrbpVDG5ivFTO6Q5Eqnf3xj14r0PxQ1hP8NnbxCQ5exQgvyxuDGNhX/a3+n8qlSue5jsneHhGd3rJx1Vtuu7uvuO40rVbDWrGLUtNmWe3mGVZf1BHYjuDWhXz78DXvUXUrViTbARvjsJDkcfUDn6CvoKrPnoS5lc//9D76liinieGZQ8cgKsrDIIPBBFeSSfDfVdHv5L3wXqzaekpy0EmWT6dwR6ZUketev0UB5o81XTviiV2vqmnKf74iYt/6CB+lYd38Mda124W48Ta89zs6KkfC+u0EhV+u2vZqKVgbbVmYmgeH9N8N2A0/TEKpnc7Mcs7Hux/yK26KKYJWP/Z", "base64");
// RIFF....WEBP with no decodable frame: sniffed as webp, refused by the decoder (a real webp is drawn: img-webp.test.mjs)
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x20, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(24, 1)]);

async function serve(cache) {
  const app = express();
  app.get("/api/img", cache.handler());
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

test("renderThumb: png and jpeg become a w x w png; an undecodable webp and unknown sizes are refused", async () => {
  const png = await renderLogo({ symbol: "Q", palette: ["#ff3366", "#113322", "#ffffff"], seed: "t" });
  for (const [bytes, type] of [[png, "image/png"], [JPEG, "image/jpeg"]]) {
    const out = await renderThumb(bytes, type, 64);
    assert.ok(out, type);
    assert.deepEqual(pngSize(out), { width: 64, height: 64 }, type);
  }
  assert.equal(await renderThumb(WEBP, "image/webp", 64), null);
  assert.equal(await renderThumb(png, "image/png", 100), null);
});

test("GET /api/img?w=: 64 px png thumbnail (cached on disk), an undecodable webp and unknown w get the original", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-thumb-"));
  const png = await renderLogo({ symbol: "Z", palette: ["#33ff66", "#112233", "#ffffff"], seed: "u" });
  const bodies = { "a.png": png, "b.jpg": JPEG, "c.webp": WEBP };
  const fetchImpl = async (url) => new Response(bodies[url.split("/").pop()], { headers: { "content-type": "application/octet-stream" } });
  const cache = new ImageCache(dir, { pacer: new HostPacer({ fetchImpl, sleep: async () => {} }), concurrency: 8 });
  const { base, close } = await serve(cache);
  const get = async (name, w) => {
    const r = await fetch(`${base}/api/img?u=${encodeURIComponent(`https://ipfs.io/ipfs/Qm/${name}`)}${w == null ? "" : `&w=${w}`}`);
    return { status: r.status, type: r.headers.get("content-type"), thumb: r.headers.get("x-img-thumb"), cc: r.headers.get("cache-control"), body: Buffer.from(await r.arrayBuffer()) };
  };
  try {
    for (const name of ["a.png", "b.jpg"]) {
      const r = await get(name, 64);
      assert.equal(r.status, 200, name);
      assert.equal(r.type, "image/png", name);
      assert.equal(r.thumb, "64", name);
      assert.match(r.cc, /public, max-age=604800/, "a thumbnail is cached 7 days");
      assert.deepEqual(pngSize(r.body), { width: 64, height: 64 }, name);
    }
    assert.ok(readdirSync(dir).some((n) => n.endsWith(".w64.png")), "thumbnail cached beside the original");
    const again = await get("a.png", 64);
    assert.equal(again.thumb, "64"); assert.equal(cache.stats.thumbHits, 1, "second read is a thumbnail cache hit");
    assert.equal(cache.stats.thumbs, 2);
    const w128 = await get("a.png", 128);
    assert.deepEqual(pngSize(w128.body), { width: 128, height: 128 });
    const webp = await get("c.webp", 64);
    assert.equal(webp.status, 200); assert.equal(webp.type, "image/webp"); assert.equal(webp.thumb, null); assert.deepEqual(webp.body, WEBP);
    const odd = await get("a.png", 77);
    assert.equal(odd.status, 200); assert.equal(odd.thumb, null); assert.deepEqual(odd.body, png, "an unknown w is ignored, never a 400");
    const plain = await get("b.jpg");
    assert.equal(plain.type, "image/jpeg"); assert.deepEqual(plain.body, JPEG);
  } finally { await close(); rmSync(dir, { recursive: true, force: true }); }
});

test("ImageCache eviction of an original leaves its thumbnail (own budget) and the thumbnail keeps serving", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-thumb-"));
  const png = await renderLogo({ symbol: "E", palette: [], seed: "e" });
  const fetchImpl = async () => new Response(png, { headers: { "content-type": "image/png" } });
  const cache = new ImageCache(dir, { pacer: new HostPacer({ fetchImpl, sleep: async () => {} }), maxBytes: 3 * png.length });
  try {
    const u0 = "https://ipfs.io/ipfs/Qm0", hit = await cache.get(u0);
    const t = await cache.thumb(u0, hit, 64);
    assert.ok(t && existsSync(t.file));
    assert.ok(cache.stats.thumbBytes > 0 && cache.stats.bytes < 2 * png.length, "the thumbnail counts in its own budget, not the originals'");
    for (let i = 1; i < 6; i++) { await new Promise((r) => setTimeout(r, 5)); await cache.get(`https://ipfs.io/ipfs/Qm${i}`); }
    assert.ok(!existsSync(hit.file), "oldest original evicted");
    assert.ok(existsSync(t.file), "its thumbnail stays");
    assert.ok(cache.stats.bytes <= 3 * png.length);
    assert.deepEqual(await cache.thumb(u0, null, 64), t, "served by its own age, no original needed");
  } finally { cache.work.close(); rmSync(dir, { recursive: true, force: true }); }
});
