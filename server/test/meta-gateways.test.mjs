// IPFS gateways (2026-11-10, GATEWAY_RULE 2): ipfs.filebase.io and 4everland.io join the rotation right after pump's
// pinata (measured that day: they served every stuck CID probed while the old public gateways answered 429 on sight); a
// rotation in which no public gateway looked for the file is a deferral (minutes, never the 16-24 h ladder), for metadata
// and images; a 429's Retry-After is honoured (capped); what failed under the old rotation is tried once more at boot
// (kv); a sheet cell whose job ended with no failure recorded is pending, not dead, and a sheet with a dead cell is cached
// a minute. Repairs of 2026-11-11: the old rule's counts of non-answers come down to the cap once at boot, a deferral never
// takes back what real failures counted, and a rotation in which a public gateway looked is stored at once, not requeued.
// Stub fetch, fake resolvers, temp dirs, in-memory sqlite: no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import { IPFS_GATEWAYS, GATEWAY_RULE, META_DEFER_S, META_DEFER_CAP, IMG_DEFER_CAP, IMG_GONE_RETRY_MS, HOST_RETRY_AFTER_MAX_MS, THUMB_RULE, THUMB_CRASHES_MAX, HostPacer, MetaFetcher, ImageCache, ImgWork,
  isGatewayDeferral, metaFailKind, metaRetryS, metaDeferS, retryAfterS, isTransientError, isAllowedMetaUrl, isAllowedImageUrl, isFetchableMetaUri, ipfsPathOf, gatewayCandidates, imgTempWaitMs } from "../lib/meta.mjs";
import { HostGuard } from "../lib/net.mjs";
import { Db } from "../lib/db.mjs";
import { renderLogo } from "../lib/agents/logo.mjs";
import { isMint } from "../lib/api.mjs";
import { PublicKey } from "../lib/sdk.mjs";
import { buildTree } from "./helpers/tree.mjs";

const quiet = { info() {}, warn() {}, error() {} };
const tick = () => new Promise((r) => setTimeout(r, 20));
const IPFS = "https://ipfs.io/ipfs/bafkreiadaymygcweepzmz3ojhphwtcw43fsc7lkm6mwb3zvn4ap4hoyq2i";
const CDN = "https://m.rapidlaunch.io/m/x";
const cdn = (name) => `https://cdn.example-launchpad.io/${name}`;
const mint = (i) => { const b = Buffer.alloc(32, 5); b.writeUInt16BE(i, 30); return new PublicKey(b).toBase58(); };
const json = () => new Response(JSON.stringify({ image: "https://ipfs.io/ipfs/QmI" }), { headers: { "content-type": "application/json" } });
let LOGO;
const logo = async () => (LOGO ??= await renderLogo({ symbol: "G", palette: ["#22aa66", "#112233", "#ffffff"], seed: "gateways" }));
// what 2,590 of the 4,900 failed IPFS metadata rows of the live index held on 2026-11-10 (attempts 7, waiting 16 h)
const LIVE = "403 pump.mypinata.cloud; net w3s.link; paused ipfs.io; paused dweb.link; paused gateway.pinata.cloud";
const failedRow = (error, attempts, fetchedAt) => ({ image: null, description: null, twitter: null, telegram: null, website: null, fetchedAt, ok: false, error, attempts, deadStreak: 0 });

test("rotation (GATEWAY_RULE 2): pump's pinata, then ipfs.filebase.io and 4everland.io, then the old public gateways; every url of 4everland's redirect is allowed and understood", () => {
  assert.equal(GATEWAY_RULE, 2);
  assert.deepEqual(IPFS_GATEWAYS.map((g) => new URL(g).hostname), ["pump.mypinata.cloud", "ipfs.filebase.io", "4everland.io", "ipfs.io", "dweb.link", "gateway.pinata.cloud", "w3s.link"]);
  const v1 = "bafkreiadaymygcweepzmz3ojhphwtcw43fsc7lkm6mwb3zvn4ap4hoyq2i", v0 = "QmReAjeMcauYuSLvrxi6E2n6pqYdED49JVS26FkWUpVSLa";
  // measured 2026-11-10: 4everland.io/ipfs/<cid> answers 301 https://<cidv1>.ipfs.4everland.io/ (a CIDv0 turned into its base32 CIDv1)
  for (const u of [`https://4everland.io/ipfs/${v1}`, `https://${v1}.ipfs.4everland.io/`, `https://ipfs.filebase.io/ipfs/${v0}`, "https://bafybeibrb7rlrgcfeywcybgkeeoyimr56ak3cazvqfbdcsebvodqjhfl4m.ipfs.4everland.io/"]) {
    assert.ok(isAllowedMetaUrl(u) && isAllowedImageUrl(u), u);
  }
  assert.equal(ipfsPathOf(`https://${v1}.ipfs.4everland.io/`), v1, "the redirect target is IPFS content");
  assert.equal(gatewayCandidates(`https://${v1}.ipfs.4everland.io/`)[0], `https://pump.mypinata.cloud/ipfs/${v1}`, "and is not asked apart: the rotation covers it");
});

test("4everland.io redirects to <cid>.ipfs.4everland.io: both hops pass the allowlist and the SSRF guard; a hop that resolves to a private address is refused and the next gateway serves", async () => {
  const cid = "bafkreighdxcwe35ar3awx757s6brhrojffcqxsnyrll7bsfshd5w2suqva", sub = `${cid}.ipfs.4everland.io`;
  let privateSub = false;
  const resolved = [], fetched = [], allowed = [];
  const guard = new HostGuard({ resolve: async (h) => { resolved.push(h); return [{ address: privateSub && h === sub ? "10.0.0.7" : "93.184.216.34", family: 4 }]; }, ttlMs: 0 });
  const fetchImpl = async (u) => {
    fetched.push(u);
    const host = new URL(u).hostname;
    if (host === "pump.mypinata.cloud" || host === "ipfs.filebase.io") return new Response("", { status: 403 });
    if (host === "4everland.io") return new Response("", { status: 301, headers: { location: `https://${sub}/` } });
    return json();
  };
  const allow = (u) => { allowed.push(u); return isAllowedMetaUrl(u); };
  const hit = await new HostPacer({ fetchImpl, guard, sleep: async () => {} }).fetchAny(`https://ipfs.io/ipfs/${cid}`, {}, { allow });
  assert.equal(hit.res.status, 200); assert.equal(hit.url, `https://${sub}/`);
  assert.deepEqual(fetched, [`https://pump.mypinata.cloud/ipfs/${cid}`, `https://ipfs.filebase.io/ipfs/${cid}`, `https://4everland.io/ipfs/${cid}`, `https://${sub}/`]);
  assert.ok(allowed.includes(`https://${sub}/`) && resolved.includes(sub), "the redirect hop went through the allowlist and the guard");
  privateSub = true; fetched.length = 0;
  const next = await new HostPacer({ fetchImpl, guard, sleep: async () => {} }).fetchAny(`https://ipfs.io/ipfs/${cid}`, {}, { allow: isAllowedMetaUrl });
  assert.equal(next.url, `https://ipfs.io/ipfs/${cid}`, "refused at the guard, the rotation went on");
  assert.ok(!fetched.includes(`https://${sub}/`), "no request to the private address");
});

test("isGatewayDeferral: no public gateway looked (paused, budget, 429/408/425, a 5xx but 504, a network error) is a deferral; a timeout, a 504, an answer from a public gateway, our resolver in trouble or a non-IPFS uri is not", () => {
  for (const t of [
    LIVE,
    "net w3s.link; 403 pump.mypinata.cloud; paused ipfs.io; paused dweb.link; paused gateway.pinata.cloud",
    "403 pump.mypinata.cloud; paused ipfs.io; paused dweb.link; paused gateway.pinata.cloud; paused w3s.link",
    "net sumo-ipfs.quicknode-ipfs.com; 403 pump.mypinata.cloud; net w3s.link; paused ipfs.io; paused dweb.link; paused gateway.pinata.cloud",
    "ENOTFOUND lpfs.io; net w3s.link; 400 pump.mypinata.cloud; paused ipfs.io; paused dweb.link; paused gateway.pinata.cloud",
    "403 emerald-used-quelea-264.mypinata.cloud; 403 pump.mypinata.cloud; net w3s.link; paused ipfs.io; paused dweb.link; paused gateway.pinata.cloud",
    "403 pump.mypinata.cloud; 429 ipfs.filebase.io; 429 4everland.io; paused ipfs.io; paused dweb.link; paused gateway.pinata.cloud; paused w3s.link",
    "403 pump.mypinata.cloud; 502 ipfs.filebase.io; 503 4everland.io; 429 ipfs.io; 520 dweb.link; 500 gateway.pinata.cloud; 408 w3s.link",
    "403 pump.mypinata.cloud; ENOTFOUND ipfs.filebase.io; paused 4everland.io; paused ipfs.io",
    "403 pump.mypinata.cloud; budget ipfs.filebase.io; budget 4everland.io",
    "429 pump.mypinata.cloud; 429 ipfs.filebase.io; 429 4everland.io; 429 ipfs.io; 429 dweb.link; 429 gateway.pinata.cloud; 429 w3s.link",
    "HTTP 429", "rate limited",
  ]) { assert.equal(isGatewayDeferral(IPFS, t), true, t); assert.equal(metaFailKind(IPFS, t), "deferred", t); assert.equal(isTransientError(t), true, `${t}: a deferral is temporary too`); }
  for (const t of [
    "403 pump.mypinata.cloud; timeout ipfs.filebase.io; timeout 4everland.io; budget ipfs.io; budget dweb.link; budget gateway.pinata.cloud; budget w3s.link",
    "403 pump.mypinata.cloud; 504 ipfs.filebase.io; 429 4everland.io; paused ipfs.io",
    "403 pump.mypinata.cloud; 404 ipfs.filebase.io; 429 4everland.io; paused ipfs.io",
    "403 pump.mypinata.cloud; 403 ipfs.filebase.io; paused 4everland.io",
    "403 pump.mypinata.cloud; 429 ipfs.io; timeout dweb.link",
    "403 pump.mypinata.cloud; ENOTFOUND ipfs.filebase.io; ENOTFOUND 4everland.io; paused ipfs.io",
    "ENOTFOUND pump.mypinata.cloud; ENOTFOUND ipfs.filebase.io; ENOTFOUND 4everland.io; ENOTFOUND ipfs.io; ENOTFOUND dweb.link; ENOTFOUND gateway.pinata.cloud; ENOTFOUND w3s.link",
    "timeout pump.mypinata.cloud; 404 own.gateway.io",
    "403 pump.mypinata.cloud; 404 ipfs.filebase.io; 404 4everland.io; 404 ipfs.io; 404 dweb.link; 404 gateway.pinata.cloud; 404 w3s.link",
    "Unexpected token ';' in JSON at position 3; paused ipfs.io",
    "HTTP 404", "HTTP 503", "body over 524288 bytes", "", null,
  ]) assert.equal(isGatewayDeferral(IPFS, t), false, String(t));
  assert.equal(metaFailKind(IPFS, "403 pump.mypinata.cloud; timeout ipfs.filebase.io; timeout 4everland.io; budget ipfs.io"), "transient", "an unpinned CID: both new gateways hang until our timeout");
  assert.equal(metaFailKind(IPFS, "403 pump.mypinata.cloud; 404 ipfs.filebase.io; 404 4everland.io; 404 ipfs.io; 404 dweb.link; 404 gateway.pinata.cloud; 404 w3s.link"), "failed");
  // only IPFS content rotates: a lone host's 429 keeps its old meaning (a summary only ever comes from a rotation)
  assert.equal(isGatewayDeferral(CDN, "HTTP 429"), false); assert.equal(isGatewayDeferral(cdn("x.png"), "rate limited"), false);
  assert.equal(metaFailKind(CDN, "HTTP 429"), "transient"); assert.equal(metaFailKind(CDN, "HTTP 404"), "dead");
  // a stored error is cut at 200 characters: a last note cut short does not hide what the others say
  const long = "net a-very-long-gateway-name-of-a-launchpad.example-launchpad-ipfs.io; 403 pump.mypinata.cloud; paused ipfs.filebase.io; paused 4everland.io; paused ipfs.io; paused dweb.link; paused gateway.pinata.cloud; paused w3s.link";
  assert.ok(long.length > 200);
  assert.equal(isGatewayDeferral(IPFS, long.slice(0, 200)), true, long.slice(0, 200));
  assert.equal(isGatewayDeferral(IPFS, long.replace("paused ipfs.io", "404 ipfs.io").slice(0, 200)), false);
});

test("metaDeferS / metaRetryS of a deferral: 10, 20, then 40 min, plus up to half of it fixed per uri; never more than an hour whatever the count; a backlog of 5k at the cap costs ~1.7 rows a second", () => {
  assert.equal(META_DEFER_S, 600); assert.equal(META_DEFER_CAP, 3);
  const uris = Array.from({ length: 5000 }, (_, i) => `https://ipfs.io/ipfs/bafkrei${i.toString(36).padStart(8, "0")}`);
  for (const [a, lo] of [[1, 600], [2, 1200], [3, 2400], [7, 2400], [500, 2400], [0, 600], [undefined, 600]]) {
    for (const u of uris.slice(0, 300)) { const s = metaDeferS(u, a); assert.ok(s >= lo && s <= lo * 1.5, `attempts ${a}: ${s} s`); }
  }
  assert.equal(metaDeferS(uris[0], 3), metaDeferS(uris[0], 3), "fixed per uri: the same at every sweep");
  assert.ok(new Set(uris.slice(0, 300).map((u) => metaDeferS(u, 3))).size > 200, "spread over the window");
  for (const attempts of [1, 4, 7, 8, 12, 500]) {
    const s = metaRetryS(IPFS, { error: LIVE, attempts });
    assert.equal(s, metaDeferS(IPFS, attempts)); assert.ok(s >= 600 && s <= 3600, `${attempts}: ${s} s`);
  }
  assert.equal(retryAfterS(7), 16 * 3600, "what the old rule waited after 7 such rotations"); assert.equal(retryAfterS(8), 24 * 3600);
  // the load a backlog of 5k rows that keep deferring puts on the workers: one rotation each per wait
  const perS = uris.reduce((s, u) => s + 1 / metaDeferS(u, META_DEFER_CAP), 0);
  assert.ok(perS > 1.5 && perS < 1.9, `${perS.toFixed(2)} rows/s`);
  // a rotation in which the gateways looked (timeouts) keeps the temporary ladder: up to a day
  const T = "403 pump.mypinata.cloud; timeout ipfs.filebase.io; timeout 4everland.io; budget ipfs.io; budget dweb.link";
  assert.deepEqual([1, 4, 8, 12].map((a) => metaRetryS(IPFS, { error: T, attempts: a })), [15 * 60, 2 * 3600, 24 * 3600, 24 * 3600]);
});

test("MetaFetcher: a row the old rule parked for 16 h (7 non-answers counted as attempts) is due now; the boot re-check brings its count down to META_DEFER_CAP once; deferring again it is stored at once and stays there; the next real answer climbs from there", async () => {
  const stored = new Map(), kv = new Map();
  const model = { meta: stored, setMeta: (uri, m) => stored.set(uri, { uri, ...m }), db: { kvGet: (k, d) => (kv.has(k) ? kv.get(k) : d), kvSet: (k, v) => kv.set(k, v) } };
  const nowS = Math.floor(Date.now() / 1000);
  stored.set(IPFS, { uri: IPFS, ...failedRow(LIVE, 7, nowS - Math.round(7.4 * 3600)) });
  let mode = "limited";
  const calls = [];
  const fetchImpl = async (u) => {
    calls.push(u);
    if (new URL(u).hostname === "pump.mypinata.cloud") return new Response("", { status: 403 });
    return mode === "limited" ? new Response("", { status: 429 }) : mode === "gone" ? new Response("", { status: 404 }) : json();
  };
  const pacer = new HostPacer({ fetchImpl, sleep: async () => {} });
  const f = new MetaFetcher(model, { pacer, concurrency: 1 });
  const again = async (m) => { mode = m; pacer.pausedUntil.clear(); calls.length = 0; stored.set(IPFS, { ...stored.get(IPFS), fetchedAt: 0 }); f.request(IPFS); await tick(); return stored.get(IPFS); };
  try {
    assert.equal(f.needsFetch(IPFS), true, "due 7.4 h after its last try (the old rule: 16 h)");
    assert.equal(f.queueGatewayRecheck(), 1);
    assert.equal(stored.get(IPFS).attempts, META_DEFER_CAP, "7 non-answers come down to the cap, once, at boot");
    f.request(IPFS); await tick();
    let row = stored.get(IPFS);
    assert.equal(metaFailKind(IPFS, row.error), "deferred"); assert.match(row.error, /^403 pump\.mypinata\.cloud; 429 ipfs\.filebase\.io/);
    assert.equal(row.attempts, META_DEFER_CAP, "a deferral keeps it there");
    assert.equal(f.stats.rateLimited, 1); assert.equal(f.stats.deferred, 1); assert.equal(f.attempts.has(IPFS), false, "stored at once, not requeued: it was a deferral already");
    assert.equal(calls.length, 7, "one rotation, not four");
    const wait = metaRetryS(IPFS, row); assert.ok(wait >= 40 * 60 && wait <= 3600, `${wait} s`);
    assert.equal(f.needsFetch(IPFS, row.fetchedAt + 3601), true);
    row = await again("limited");
    assert.equal(row.attempts, META_DEFER_CAP, "and stays there");
    // every public gateway says no: a failed attempt, climbing from the cap (2 h), not from 8 (a day)
    row = await again("gone");
    assert.equal(metaFailKind(IPFS, row.error), "failed"); assert.equal(row.attempts, META_DEFER_CAP + 1); assert.equal(metaRetryS(IPFS, row), 2 * 3600);
    // a new uri's first deferral is requeued as before (three times), not stored
    const fresh = "https://ipfs.io/ipfs/QmFreshCoin";
    mode = "limited"; pacer.pausedUntil.clear(); f.request(fresh); await tick();
    assert.equal(stored.has(fresh), false); assert.equal(f.attempts.get(fresh), 1);
    row = await again("ok");
    assert.equal(row.ok, true); assert.equal(row.attempts, 0); assert.equal(row.image, "https://ipfs.io/ipfs/QmI");
  } finally { f.stop(); }
});

// pump's pinata 403; "timeout": ipfs.filebase.io and 4everland.io hang until our timeout (a CID nobody has), the old public
// gateways 429; "defer": every public gateway 429; "gone": every public gateway 404
const rotation = (mode) => async (u) => {
  const h = new URL(u).hostname;
  if (h === "pump.mypinata.cloud") return new Response("", { status: 403 });
  if (mode() === "timeout" && (h === "ipfs.filebase.io" || h === "4everland.io")) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  return new Response("", { status: mode() === "gone" ? 404 : 429 });
};

test("a row the old rule parked (7 non-answers), re-checked at boot, whose first rotation is a real answer climbs from the cap: a timeout (an unpinned CID) or a definitive no waits 2 h, not a day (repair 2026-11-11)", async () => {
  for (const [mode, kind] of [["timeout", "transient"], ["gone", "failed"]]) {
    const { db, model } = buildTree();
    const U = "https://ipfs.io/ipfs/ROOT"; // the tracked root's uri
    model.setMeta(U, failedRow(LIVE, 7, Math.floor(Date.now() / 1000) - Math.round(7.4 * 3600)));
    const f = new MetaFetcher(model, { pacer: new HostPacer({ fetchImpl: rotation(() => mode), sleep: async () => {} }), concurrency: 1, log: quiet });
    try {
      assert.equal(f.queueGatewayRecheck(), 1);
      f.request(U); await tick();
      const row = model.meta.get(U);
      assert.equal(metaFailKind(U, row.error), kind, row.error);
      assert.equal(row.attempts, META_DEFER_CAP + 1, mode); assert.equal(metaRetryS(U, row), 2 * 3600, `${mode}: it waited a day`);
      assert.equal(db.metaGet(U).attempts, META_DEFER_CAP + 1);
    } finally { f.stop(); db.close(); }
  }
});

test("MetaFetcher (repair 2026-11-11): a rotation in which a public gateway looked (filebase and 4everland timed out, the old ones 429) is stored at once, one rotation per failure; one in which none looked is still requeued", async () => {
  const stored = new Map(), asked = new Map();
  let mode = "timeout";
  const answer = rotation(() => mode);
  const pacer = new HostPacer({ fetchImpl: async (u) => { const h = new URL(u).hostname; asked.set(h, (asked.get(h) ?? 0) + 1); return answer(u); }, sleep: async () => {} });
  const f = new MetaFetcher({ meta: stored, setMeta: (uri, m) => stored.set(uri, { uri, ...m }) }, { pacer, concurrency: 1 });
  const unpinned = "https://ipfs.io/ipfs/bafkreiunpinnedcid";
  try {
    f.request(unpinned); await tick();
    const row = stored.get(unpinned);
    assert.ok(row, "stored after one rotation (requeued, it held a worker ~20 s per rotation, four rotations per failure)");
    assert.equal(metaFailKind(unpinned, row.error), "transient"); assert.equal(row.attempts, 1); assert.match(row.error, /^403 pump\.mypinata\.cloud; timeout ipfs\.filebase\.io/);
    assert.equal(asked.get("pump.mypinata.cloud"), 1); assert.equal(asked.get("ipfs.filebase.io"), 1); assert.equal(asked.get("4everland.io"), 1);
    assert.equal(f.stats.rateLimited, 1); assert.equal(f.attempts.has(unpinned), false);
    mode = "defer"; pacer.pausedUntil.clear();
    const fresh = "https://ipfs.io/ipfs/QmNobodyLooked";
    f.request(fresh); await tick();
    assert.equal(stored.has(fresh), false, "nobody looked: requeued, as before"); assert.equal(f.attempts.get(fresh), 1);
  } finally { f.stop(); }
});

test("a deferral never takes back what real failures counted (repair 2026-11-11): an unpinned CID's timeouts keep climbing through deferrals in between, for metadata and images, while each deferral still waits minutes", async () => {
  let mode = "timeout";
  const stored = new Map();
  const pacer = new HostPacer({ fetchImpl: rotation(() => mode), sleep: async () => {} });
  const f = new MetaFetcher({ meta: stored, setMeta: (uri, m) => stored.set(uri, { uri, ...m }) }, { pacer, concurrency: 1 });
  const U = "https://ipfs.io/ipfs/bafkreiunpinnedcid";
  const step = async (m) => { mode = m; pacer.pausedUntil.clear(); f.attempts.set(U, 3); const r = stored.get(U); if (r) stored.set(U, { ...r, fetchedAt: 0 }); f.request(U); await tick(); return stored.get(U); };
  try {
    let row;
    for (let i = 0; i < 6; i++) row = await step("timeout");
    assert.equal(row.attempts, 6); assert.equal(metaRetryS(U, row), 8 * 3600);
    for (let i = 0; i < 2; i++) {
      row = await step("defer");
      assert.equal(metaFailKind(U, row.error), "deferred"); assert.equal(row.attempts, 6, "kept: it came down to the cap"); assert.ok(metaRetryS(U, row) <= 3600, "and asked again within the hour");
    }
    row = await step("timeout");
    assert.equal(row.attempts, 7); assert.equal(metaRetryS(U, row), 16 * 3600, "the climb goes on (it restarted at 2 h)");
  } finally { f.stop(); }
  let clock = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "spore-gw-keep-"));
  const work = new ImgWork({ inline: true, log: quiet });
  const ipacer = new HostPacer({ fetchImpl: rotation(() => mode), sleep: async () => {} });
  const cache = new ImageCache(dir, { pacer: ipacer, work, log: quiet, now: () => clock });
  const u = "https://ipfs.io/ipfs/QmUnpinnedLogo/logo.png";
  const istep = async (m) => { mode = m; const prev = cache.fails.get(u); if (prev) clock = prev.retryAt + 1; ipacer.pausedUntil.clear(); assert.equal(await cache.get(u), null); return cache.fails.get(u); };
  try {
    let fl;
    for (let i = 0; i < 9; i++) fl = await istep("timeout");
    assert.equal(fl.attempts, 9); assert.equal(fl.retryAt - fl.at, imgTempWaitMs(9));
    fl = await istep("defer");
    assert.equal(fl.attempts, 9, "kept"); assert.ok(fl.retryAt - fl.at <= imgTempWaitMs(IMG_DEFER_CAP) * 1.5, `${fl.retryAt - fl.at} ms`); assert.equal(cache.isPending(u), true);
    fl = await istep("timeout");
    assert.equal(fl.attempts, 10); assert.equal(fl.retryAt - fl.at, imgTempWaitMs(10));
  } finally { cache.close(); work.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a null rotation (every candidate paused or answering 429) still stores its per-gateway summary (fetchAny's `out`), for metadata and images: a deferral, not \"HTTP 429\"", async () => {
  const all429 = async () => new Response("", { status: 429 });
  const out = {};
  assert.equal(await new HostPacer({ fetchImpl: all429, sleep: async () => {} }).fetchAny(IPFS, {}, { out }), null);
  assert.equal(out.limited, true); assert.equal(out.transient, true); assert.match(out.summary, /^429 pump\.mypinata\.cloud; 429 ipfs\.filebase\.io; 429 4everland\.io; 429 ipfs\.io/);
  const lone = {};
  assert.equal(await new HostPacer({ fetchImpl: all429, sleep: async () => {} }).fetchAny(CDN, {}, { out: lone }), null);
  assert.equal(lone.summary, null, "one candidate: no summary");
  const stored = new Map();
  const f = new MetaFetcher({ meta: stored, setMeta: (uri, m) => stored.set(uri, { uri, ...m }) }, { pacer: new HostPacer({ fetchImpl: all429, sleep: async () => {} }), concurrency: 1 });
  try {
    f.attempts.set(IPFS, 3); f.request(IPFS); await tick();
    assert.match(stored.get(IPFS).error, /^429 pump\.mypinata\.cloud; 429 ipfs\.filebase\.io/); assert.equal(metaFailKind(IPFS, stored.get(IPFS).error), "deferred");
  } finally { f.stop(); }
  const dir = mkdtempSync(join(tmpdir(), "spore-gw-null-"));
  const work = new ImgWork({ inline: true, log: quiet });
  const cache = new ImageCache(dir, { pacer: new HostPacer({ fetchImpl: all429, sleep: async () => {} }), work, log: quiet });
  try {
    const u = "https://ipfs.io/ipfs/QmNullLogo/logo.png";
    assert.equal(await cache.get(u), null);
    assert.match(cache.failureOf(u).error, /^429 pump\.mypinata\.cloud; 429 ipfs\.filebase\.io/); assert.equal(cache.isPending(u), true);
    assert.equal(await cache.get(cdn("lone.png")), null); assert.equal(cache.failureOf(cdn("lone.png")).error, "rate limited", "a lone host keeps its text");
  } finally { cache.close(); work.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("images: a deferral (pump's pinata 403, the public gateways rate-limited) never counts past IMG_DEFER_CAP, so it waits minutes however often it comes and stays pending (a 503, a pending cell); a rotation in which the gateways looked (timeouts) climbs as before", async () => {
  assert.equal(IMG_DEFER_CAP, 4);
  let clock = Date.now(), mode = "limited";
  const fetchImpl = async (u) => {
    if (new URL(u).hostname === "pump.mypinata.cloud") return new Response("", { status: 403 });
    if (mode === "timeout") throw new Error("The operation was aborted due to timeout");
    return new Response("", { status: mode === "gone" ? 404 : 429 });
  };
  const dir = mkdtempSync(join(tmpdir(), "spore-gw-img-"));
  const work = new ImgWork({ inline: true, log: quiet });
  const pacer = new HostPacer({ fetchImpl, sleep: async () => {} });
  const cache = new ImageCache(dir, { pacer, work, log: quiet, now: () => clock });
  const step = async (u) => { const prev = cache.fails.get(u); if (prev) clock = prev.retryAt + 1; pacer.pausedUntil.clear(); assert.equal(await cache.get(u), null); return cache.fails.get(u); };
  try {
    const u = "https://ipfs.io/ipfs/QmDeferred/logo.png";
    const seen = [];
    for (let i = 0; i < 12; i++) { const f = await step(u); seen.push(f.attempts); assert.equal(f.kind, "temp"); assert.ok(f.retryAt - f.at <= imgTempWaitMs(IMG_DEFER_CAP) * 1.5, `${f.retryAt - f.at} ms`); }
    assert.deepEqual(seen, [1, 2, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4]);
    assert.equal(cache.isPending(u), true); assert.equal(cache.isDead(u), false);
    // the same url when the gateways looked and found nothing (timeouts): the temporary ladder, past an hour after 6
    mode = "timeout";
    const v = "https://ipfs.io/ipfs/QmUnpinned/logo.png";
    let f;
    for (let i = 0; i < 9; i++) f = await step(v);
    assert.equal(f.attempts, 9); assert.equal(f.retryAt - f.at, imgTempWaitMs(9)); assert.ok(f.retryAt - f.at > 4 * 3600_000);
    // and the deferred one, once every public gateway says no: a permanent failure, an hour first
    mode = "gone";
    f = await step(u);
    assert.equal(f.kind, "gone"); assert.equal(f.attempts, 1); assert.equal(f.retryAt - f.at, IMG_GONE_RETRY_MS[0]); assert.equal(cache.isDead(u), true);
  } finally { cache.close(); work.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("HostPacer: a 429's Retry-After pauses the host that long (dweb.link asks 900 s), capped at 15 min; without one, or with a shorter or unreadable one, the doubling pause (10 s first)", async () => {
  assert.equal(HOST_RETRY_AFTER_MAX_MS, 15 * 60_000);
  let ra = null, calls = 0;
  const fetchImpl = async () => { calls++; return new Response("", { status: 429, headers: ra == null ? {} : { "retry-after": ra } }); };
  const pause = async (value) => { ra = value; const p = new HostPacer({ fetchImpl, sleep: async () => {} }); const t0 = Date.now(); assert.equal(await p.fetchAny(CDN), null); return { p, ms: p.pausedUntil.get("m.rapidlaunch.io") - t0 }; };
  const near = (ms, want) => Math.abs(ms - want) < 2_000;
  let r = await pause("900"); assert.ok(near(r.ms, 900_000), `${r.ms}`);
  calls = 0; assert.equal(await r.p.fetchAny(CDN), null); assert.equal(calls, 0, "paused: not asked again");
  r = await pause("3600"); assert.ok(near(r.ms, HOST_RETRY_AFTER_MAX_MS), `${r.ms}`);
  r = await pause(new Date(Date.now() + 120_000).toUTCString()); assert.ok(near(r.ms, 120_000), `${r.ms}`);
  for (const v of [null, "1", "soon", ""]) { r = await pause(v); assert.ok(near(r.ms, 10_000), `${v}: ${r.ms}`); }
});

test("gateway re-check (GATEWAY_RULE): at boot every failed row of IPFS content whose error is temporary is due once whatever its backoff, in the sweep's order; a definitive no, other hosts and resolved rows keep their wait; gated by kv", () => {
  const { db, model } = buildTree();
  const nowS = Math.floor(Date.now() / 1000);
  const U = (s) => `https://ipfs.io/ipfs/${s}`;
  model.setMeta(U("AAA"), { image: "https://ipfs.io/ipfs/imgA", description: null, twitter: null, telegram: null, website: null, fetchedAt: nowS, ok: true }); // resolved, fresh
  model.setMeta(U("ROOT"), failedRow(LIVE, 7, nowS));                                                                        // a deferral under the old rule
  model.setMeta(U("BBB"), failedRow("403 pump.mypinata.cloud; timeout w3s.link; budget ipfs.io; budget dweb.link", 9, nowS)); // temporary, a day's wait
  model.setMeta(U("GGG"), failedRow("403 pump.mypinata.cloud; 404 ipfs.io; 404 dweb.link; 404 gateway.pinata.cloud; 404 w3s.link", 3, nowS)); // a definitive no
  model.setMeta(U("Q429"), failedRow("HTTP 429", 4, nowS));                                                                  // every gateway paused (no coin behind it)
  model.setMeta(U("QBIG"), failedRow("body over 524288 bytes", 1, nowS));                                                    // not temporary
  model.setMeta("https://m.rapidlaunch.io/m/cdn", failedRow("HTTP 503", 2, nowS));                                          // temporary, not IPFS
  const logs = [];
  const log = { info: (m) => logs.push(m), warn() {} };
  const f = new MetaFetcher(model, { concurrency: 0, pacer: { fetchAny: async () => null }, log });
  assert.equal(f.needsFetch(U("ROOT")), false, "before the re-check: its deferral wait (40-60 min) runs");
  f.start({ sweepMs: 3_600_000 }); f.stop();
  assert.ok(logs.includes("meta: gateway recheck queued 3"), logs.join("\n"));
  assert.deepEqual([...f.recheck].sort(), [U("BBB"), U("Q429"), U("ROOT")]);
  // (repair 2026-11-11) the old rule's counts of rotations no public gateway looked at come down to the cap, in memory and on
  // disk, so the next real answer climbs from there; a count of real failures (BBB's timeouts) and a definitive no keep theirs
  assert.ok(logs.includes(`meta: gateway rule ${GATEWAY_RULE}: 2 retry counts of rotations no public gateway looked at brought down to ${META_DEFER_CAP}`), logs.join("\n"));
  for (const [u, a] of [[U("ROOT"), META_DEFER_CAP], [U("Q429"), META_DEFER_CAP], [U("BBB"), 9], [U("GGG"), 3]]) { assert.equal(model.meta.get(u).attempts, a, u); assert.equal(db.metaGet(u).attempts, a, u); }
  assert.equal(db.kvGet("metaGatewayRule"), GATEWAY_RULE);
  const queued = f.queue.slice(f.head);
  assert.equal(queued[0], U("ROOT"), "the sweep's order: largest locked value first");
  assert.ok(queued.includes(U("BBB")) && !queued.includes(U("GGG")) && !queued.includes(U("AAA")));
  assert.equal(f.needsFetch(U("GGG")), false, "a definitive no keeps its wait"); assert.equal(f.needsFetch("https://m.rapidlaunch.io/m/cdn"), false);
  const f2 = new MetaFetcher(model, { concurrency: 0, pacer: { fetchAny: async () => null }, log });
  assert.equal(f2.queueGatewayRecheck(), 0, "once per rule, not once per boot");
  assert.equal(new MetaFetcher({ meta: new Map([[U("x"), failedRow(LIVE, 7, nowS)]]) }, { concurrency: 0, log }).queueGatewayRecheck(), 0, "no database: nothing to gate on");
  db.close();
});

test("img gateway rule (GATEWAY_RULE): at boot the IPFS failures of the old rotation that were temporary or carry a per-gateway summary are forgotten, once; failures about the bytes and other hosts stay", () => {
  const db = new Db(":memory:");
  db.kvSet("imgThumbRule", THUMB_RULE); // that rule ran long ago (it drops the "nothumb" rows itself)
  const now = Date.now();
  const row = (url, kind, error) => db.imgFailSet({ url, kind, error, attempts: 3, at: now, retryAt: now + 3600_000 });
  const dropped = ["https://ipfs.io/ipfs/QmT/a.png", "https://ipfs.io/ipfs/QmR", "https://ipfs.io/ipfs/QmG"];
  const kept = ["https://ipfs.io/ipfs/QmL", "https://ipfs.io/ipfs/QmH", "https://ipfs.io/ipfs/QmN", cdn("t.png"), cdn("g.png")];
  row(dropped[0], "temp", LIVE); row(dropped[1], "temp", "rate limited");
  row(dropped[2], "gone", "403 pump.mypinata.cloud; 404 ipfs.io; 404 dweb.link; 404 gateway.pinata.cloud; 404 w3s.link");
  row(kept[0], "gone", "too large"); row(kept[1], "gone", "not a raster image (text/html)"); row(kept[2], "nothumb", "not drawable");
  row(kept[3], "temp", "HTTP 503"); row(kept[4], "gone", "HTTP 404");
  const dir = mkdtempSync(join(tmpdir(), "spore-gw-rule-"));
  const work = new ImgWork({ inline: true, log: quiet });
  const logs = [];
  const mk = () => new ImageCache(dir, { pacer: new HostPacer({ fetchImpl: async () => { throw new Error("no network"); }, sleep: async () => {} }), work, store: db, log: { ...quiet, info: (m) => logs.push(m) } });
  try {
    const c = mk();
    assert.deepEqual(db.imgFailAll().map((f) => f.url).sort(), [...kept].sort());
    for (const u of dropped) assert.equal(c.failureOf(u), null, u);
    for (const u of kept) assert.ok(c.failureOf(u), u);
    assert.equal(db.kvGet("imgGatewayRule"), GATEWAY_RULE);
    assert.ok(logs.some((m) => m === `img: gateway rule ${GATEWAY_RULE}: 3 IPFS failures of the old rotation forgotten`), logs.join("\n"));
    row("https://ipfs.io/ipfs/QmT2", "temp", LIVE);
    const c2 = mk();
    assert.ok(c2.failureOf("https://ipfs.io/ipfs/QmT2"), "once per rule, not once per boot");
    c.close(); c2.close();
  } finally { work.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("logo sheet (repair 2026-11-10): a job that ends with no failure recorded (the image worker crashed, the original vanished under the render) leaves its cell pending, not dead, until the worker died twice in a row on that logo; a url the proxy will not fetch is dead without a job; cache-control: logos only 10 min, with a dead cell 1 min, with a pending one not stored", async () => {
  const real = new ImgWork({ inline: true, log: quiet });
  let fault = "crash", fetches = 0;
  const work = {
    thumb: async (a) => {
      if (fault === "crash") throw Object.assign(new Error("image worker failed: image worker exited (1)"), { transient: true });
      if (fault === "enoent") throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
      return real.thumb(a);
    },
    sheet: (a) => real.sheet(a), card: (a) => real.card(a), close: () => real.close(),
  };
  const dir = mkdtempSync(join(tmpdir(), "spore-gw-sheet-"));
  const cache = new ImageCache(dir, { pacer: new HostPacer({ fetchImpl: async () => { fetches++; return new Response(await logo(), { headers: { "content-type": "image/png" } }); }, sleep: async () => {} }), work, log: quiet, concurrency: 4 });
  const A = mint(1), B = mint(2), X = mint(3), C = mint(4);
  const images = { [A]: cdn("a.png"), [B]: cdn("b.png"), [X]: "http://cdn.example-launchpad.io/plain.png", [C]: cdn("poison.png") };
  const app = express();
  app.get("/api/logo-sheet", cache.sheetHandler({ imageOf: (m) => images[m] ?? null, isMint }));
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const sheet = async (mints) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/logo-sheet?w=64&m=${mints.join(",")}`); await r.arrayBuffer(); return { bits: r.headers.get("x-sheet"), dead: r.headers.get("x-sheet-dead"), pending: r.headers.get("x-sheet-pending"), cc: r.headers.get("cache-control") }; };
  try {
    assert.deepEqual(await sheet([A]), { bits: "00", dead: "00", pending: "1", cc: "no-store" }, "the worker crashed: pending (it was dead, and the browser refused the logo 15 min and more)");
    assert.equal(cache.failureOf(cdn("a.png")), null); assert.equal(cache.isDead(cdn("a.png")), false);
    fault = "enoent";
    assert.deepEqual(await sheet([B]), { bits: "00", dead: "00", pending: "1", cc: "no-store" }, "the original vanished under the render: pending too");
    // a logo the worker dies under twice in a row is taken as one that cannot be drawn: it would take the worker down at every ask
    fault = "crash";
    assert.equal((await sheet([C])).pending, "1");
    assert.equal(THUMB_CRASHES_MAX, 2);
    assert.deepEqual(await sheet([C]), { bits: "00", dead: "01", pending: "0", cc: "private, max-age=60" });
    assert.equal(cache.failureOf(cdn("poison.png")).kind, "nothumb");
    fault = null;
    assert.deepEqual(await sheet([A, B]), { bits: "03", dead: "00", pending: "0", cc: "private, max-age=600" }, "the next ask draws both; logos only: 10 min");
    assert.equal(cache.renderCrashes.size, 0, "a logo drawn at last forgets its crash");
    assert.deepEqual(await sheet([A, X]), { bits: "01", dead: "02", pending: "0", cc: "private, max-age=60" }, "a dead cell: a minute");
    assert.equal(fetches, 3, "one download each; the url the proxy will not fetch started none"); assert.equal(cache.isDead(images[X]), true);
  } finally { await new Promise((r) => srv.close(r)); cache.close(); work.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("ipfs:// metadata uris (2026-11-11) are fetched through the gateway rotation: request() and the sweep take them, and every request goes to an https gateway", async () => {
  const cid = "bafkreiadaymygcweepzmz3ojhphwtcw43fsc7lkm6mwb3zvn4ap4hoyq2i";
  const U = `ipfs://${cid}`, U2 = "ipfs://ipfs/QmReAjeMcauYuSLvrxi6E2n6pqYdED49JVS26FkWUpVSLa";
  assert.equal(isFetchableMetaUri(U), true); assert.equal(isFetchableMetaUri(U2), true); assert.equal(isFetchableMetaUri(CDN), true);
  for (const no of ["ipfs://", "http://qpqpqpqpqp.com/metadata/a.json", "data:application/json;base64,e30=", "https://127.0.0.1/m.json", null]) assert.equal(isFetchableMetaUri(no), false, String(no));
  assert.equal(isAllowedMetaUrl(U), false, "the https rule itself is unchanged");
  const asked = [], stored = new Map();
  const pacer = new HostPacer({ fetchImpl: async (u) => { asked.push(u); return json(); }, sleep: async () => {} });
  const model = { meta: stored, setMeta: (uri, m) => stored.set(uri, { uri, ...m }), coins: new Map([["A", { mint: "A", tracked: true, createdAt: 1 }]]), mints: new Map([["A", { uri: U2 }]]) };
  const f = new MetaFetcher(model, { pacer, concurrency: 1, log: quiet });
  try {
    f.request(U); await tick();
    assert.equal(stored.get(U)?.ok, true, "fetched (it was never asked before)"); assert.ok(stored.get(U).image);
    assert.equal(asked[0], `https://pump.mypinata.cloud/ipfs/${cid}`, "the rotation's first gateway");
    assert.equal(f.sweep(), 1, "the sweep queues a tracked coin's ipfs:// uri"); await tick();
    assert.equal(stored.get(U2)?.ok, true);
    assert.ok(asked.length === 2 && asked.every((u) => u.startsWith("https://") && u.includes("/ipfs/Qm") === (u !== asked[0])), asked.join(" "));
  } finally { f.stop(); }
});
