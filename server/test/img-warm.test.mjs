// Map logos from far (owner 2026-10-21): ImageCache.warm makes each url's 64 px thumbnail ahead of the
// first visitor, through get() and thumb(); a second pass is all hits; a broken url counts as failed.
// Model.warmImageUrls lists every family top's logo plus gen-1 of the biggest families. Stub fetch only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ImageCache, HostPacer } from "../lib/meta.mjs";
import { renderLogo } from "../lib/agents/logo.mjs";

test("ImageCache.warm: missing thumbnails are made (concurrency-limited), fresh ones are hits, a failure is counted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-warm-"));
  const png = await renderLogo({ symbol: "W", palette: ["#33ff66", "#112233", "#ffffff"], seed: "w" });
  let fetches = 0, inflight = 0, maxInflight = 0;
  const fetchImpl = async (url) => {
    fetches++; inflight++; maxInflight = Math.max(maxInflight, inflight);
    await new Promise((r) => setTimeout(r, 5)); inflight--;
    return url.endsWith("bad.png") ? new Response("nope", { status: 404 }) : new Response(png, { headers: { "content-type": "image/png" } });
  };
  const cache = new ImageCache(dir, { pacer: new HostPacer({ fetchImpl, sleep: async () => {} }), concurrency: 8, log: { info() {}, warn() {}, error() {} } });
  try {
    const urls = Array.from({ length: 10 }, (_, i) => `https://ipfs.io/ipfs/Qm/${i}.png`);
    const bad = "https://ipfs.io/ipfs/Qm/bad.png";
    const r = await cache.warm([...urls, urls[0], bad], 64, 4);
    assert.equal(r.n, 11); assert.equal(r.ok, 10); assert.equal(r.failed, 1); assert.equal(r.skipped, 0); assert.equal(r.stopped, false);
    assert.ok(maxInflight <= 4, `at most 4 at a time (saw ${maxInflight})`);
    for (const u of urls) { const hit = await cache.get(u); assert.ok(existsSync(`${hit.file}.w64.png`), u); }
    const f0 = fetches, t0 = cache.stats.thumbs;
    const again = await cache.warm([...urls, bad], 64, 4);
    assert.equal(again.ok, 10); assert.equal(fetches, f0, "fresh originals are not fetched again"); assert.equal(cache.stats.thumbs, t0, "fresh thumbnails are not redrawn");
    assert.equal(again.failed, 1); assert.equal(again.skipped, 1, "a url that failed in an earlier pass is not fetched again (WARM_RETRY_MS)");
    const empty = await cache.warm([], 64, 4);
    assert.equal(empty.n, 0); assert.equal(empty.ok, 0); assert.equal(empty.failed, 0);
    // a pass stops at its time budget and says so; the next pass picks the rest up
    const more = Array.from({ length: 6 }, (_, i) => `https://ipfs.io/ipfs/Qm/more${i}.png`);
    const cut = await cache.warm(more, 64, 1, { maxMs: 0 });
    assert.equal(cut.stopped, true); assert.ok(cut.ok + cut.failed < more.length, "stopped early");
    const rest = await cache.warm(more, 64, 4);
    assert.equal(rest.ok, 6);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Model.warmImageUrls: every family top's logo (roots with a child, asset tops) plus gen-1 of the biggest families", async () => {
  const { Db } = await import("../lib/db.mjs");
  const { Model } = await import("../lib/model.mjs");
  const { K, PLATFORM, quiet, base, T22 } = await import("./helpers/tree.mjs");
  const m = new Model(new Db(":memory:"), { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "all", log: quiet });
  m.load();
  const CARDS = "CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp";
  m.upsertCoin({ mint: K.ROOT, curve: "C1", depth: 0, quoteMint: null, ...base });
  m.upsertCoin({ mint: K.A, curve: "C2", depth: 1, quoteMint: K.ROOT, ...base });
  m.upsertCoin({ mint: K.G, curve: "C3", depth: 2, quoteMint: K.A, ...base });
  m.upsertCoin({ mint: K.X, curve: "C4", depth: 0, quoteMint: CARDS, ...base });
  m.upsertCoin({ mint: K.U, curve: "C5", depth: 0, quoteMint: null, ...base }); // a root without children: not a family top
  for (const [mint, s] of [[K.ROOT, "r"], [K.A, "a"], [K.G, "g"], [K.X, "x"], [K.U, "u"], [CARDS, "cards"]]) {
    m.setMint({ mint, decimals: 6, tokenProgram: T22, name: s, symbol: s, uri: `https://ipfs.io/ipfs/Qm/${s}.json`, onchainAt: 1 });
    m.setMeta(`https://ipfs.io/ipfs/Qm/${s}.json`, { image: `https://ipfs.io/ipfs/Qm/${s}.png` });
  }
  const urls = m.warmImageUrls(60).map((u) => u.split("/").pop()).sort();
  assert.deepEqual(urls, ["a.png", "cards.png", "r.png"], "ROOT (top), A (gen-1 of a big family), CARDS (asset top); not G (gen-2) nor the childless U; X is a member of CARDS");
  // with `all`: the same head (most wanted first), then every other tracked coin's logo (a zoom into any family asks for its children)
  const all = m.warmImageUrls(60, true).map((u) => u.split("/").pop());
  assert.deepEqual(all.slice(0, 3).sort(), ["a.png", "cards.png", "r.png"], "tops and gen-1 of the big families stay first");
  assert.deepEqual(all.slice(3).sort(), ["g.png", "u.png", "x.png"], "then the rest: G (gen-2), U (childless), X (asset child)");
  assert.equal(new Set(all).size, all.length, "deduped");
});
