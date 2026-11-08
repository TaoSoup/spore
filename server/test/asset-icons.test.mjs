// Listed-asset logos (lib/asset-icons.mjs): an asset top whose mint metadata has no image (USDC, WBTC,
// WETH …) gets the token list's https icon, registered with the image proxy and persisted; the mint's
// own metadata image wins; nothing else is accepted. The token list is mocked: no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Model } from "../lib/model.mjs";
import { imageProxyUrl } from "../lib/meta.mjs";
import { refreshAssetIcons, assetMintsWithoutImage, iconsFrom, startAssetIcons, ASSET_ICON_URL, ASSET_ICON_BATCH } from "../lib/asset-icons.mjs";
import { buildTree, K, T22, base, PLATFORM, quiet } from "./helpers/tree.mjs";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ICON = `https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/${USDC}/logo.png`;

/** buildTree + two asset families: USDC (no metadata image) and ASSET K.X (metadata image of its own). */
function withAssets() {
  const { db, model } = buildTree();
  model.setMint({ mint: USDC, decimals: 6, tokenProgram: T22, name: "USD Coin", symbol: "USDC", uri: null, onchainAt: 1 });
  model.setMint({ mint: K.X, decimals: 6, tokenProgram: T22, name: "Asset coin", symbol: "ASSET", uri: "https://ipfs.io/ipfs/ASSETMETA", onchainAt: 1 });
  model.setMeta("https://ipfs.io/ipfs/ASSETMETA", { image: "https://ipfs.io/ipfs/assetImg", fetchedAt: 1, ok: true });
  model.upsertCoin({ mint: K.U, curve: "C_U", depth: 0, quoteMint: USDC, ...base, virtualQuoteReserves: "1000000000000000", realQuoteReserves: "3000000", tracked: true, createdAt: 5000 });
  model.upsertCoin({ mint: K.S, curve: "C_S", depth: 0, quoteMint: K.X, ...base, virtualQuoteReserves: "1000000000000000", realQuoteReserves: "2000000", tracked: true, createdAt: 6000 });
  return { db, model };
}
/** A token-list stand-in: answers every asked mint from `table` (mint → row), recording the calls. */
const fakeList = (table, calls = []) => async (u) => {
  calls.push(u);
  const asked = decodeURIComponent(String(u).slice(ASSET_ICON_URL.length)).split(",");
  return new Response(JSON.stringify(asked.map((m) => table[m]).filter(Boolean)), { headers: { "content-type": "application/json" } });
};

test("an asset without a metadata image gets the listed icon: stored, on the asset node, known to the proxy", async () => {
  const { db, model } = withAssets();
  try {
    assert.equal(model.assetMapRef(USDC).image, null, "no logo before");
    assert.deepEqual(assetMintsWithoutImage(model), [USDC], "ASSET has its own metadata image: not asked");
    const calls = [];
    const r = await refreshAssetIcons({ model, fetchImpl: fakeList({ [USDC]: { id: USDC, symbol: "USDC", icon: ICON } }, calls) });
    assert.deepEqual(r, { asked: 1, calls: 1, failed: 0, found: 1, changed: 1 });
    assert.equal(calls.length, 1); assert.ok(calls[0].startsWith(ASSET_ICON_URL) && calls[0].includes(USDC));
    assert.equal(model.assetIconOf(USDC), ICON);
    assert.equal(model.assetMapRef(USDC).image, imageProxyUrl(ICON));
    assert.equal(model.knownImage(ICON), true, "the proxy may fetch it");
    const node = model.mapAll({ all: true }).body.roots.find((x) => x.coin.mint === USDC);
    assert.equal(node.coin.image, imageProxyUrl(ICON), "the full map's asset node has the logo");
    assert.equal(model.assetMapRef(K.X).image, imageProxyUrl("https://ipfs.io/ipfs/assetImg"), "metadata image untouched");
    // the asset node rides the next delta with its member
    const delta = model.mapSince({ all: true, since: 0 }).body.nodes.find((n) => n.mint === USDC);
    assert.equal(delta.image, imageProxyUrl(ICON));
    // a second pass with the same answer changes nothing (no bump)
    const v = model.version;
    assert.equal((await refreshAssetIcons({ model, fetchImpl: fakeList({ [USDC]: { id: USDC, icon: ICON } }) })).changed, 0);
    assert.equal(model.version, v);
    // persisted: a fresh model on the same database restores it at load()
    const m2 = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 2500, 1000, 1500], log: quiet });
    m2.load();
    assert.equal(m2.assetIconOf(USDC), ICON); assert.equal(m2.knownImage(ICON), true);
    assert.equal(m2.assetMapRef(USDC).image, imageProxyUrl(ICON));
  } finally { db.close(); }
});

test("the mint's own metadata image wins over a stored icon", async () => {
  const { db, model } = withAssets();
  try {
    model.setAssetIcons({ [USDC]: ICON });
    model.setMint({ mint: USDC, uri: "https://ipfs.io/ipfs/USDCMETA" });
    model.setMeta("https://ipfs.io/ipfs/USDCMETA", { image: "https://ipfs.io/ipfs/usdcOwn", fetchedAt: 1, ok: true });
    assert.equal(model.assetMapRef(USDC).image, imageProxyUrl("https://ipfs.io/ipfs/usdcOwn"));
    assert.deepEqual(assetMintsWithoutImage(model), [], "nothing left to ask");
  } finally { db.close(); }
});

test("only https icons on public hosts are accepted, for the asked mints only", async () => {
  const asked = new Set(["A1", "A2", "A3", "A4", "A5", "A6"]);
  const got = iconsFrom([
    { id: "A1", icon: "http://example.com/a.png" },
    { id: "A2", icon: "https://127.0.0.1/a.png" },
    { id: "A3", icon: "https://localhost/a.png" },
    { id: "A4", icon: "data:image/png;base64,AAAA" },
    { id: "A5", icon: `https://cdn.example.com/${"x".repeat(2000)}.png` },
    { id: "A6", icon: "https://cdn.example.com/a6.png" },
    { id: "NOT_ASKED", icon: "https://cdn.example.com/n.png" },
    { id: "A1" }, null, "junk",
  ], asked);
  assert.deepEqual(got, { A6: "https://cdn.example.com/a6.png" });
  assert.deepEqual(iconsFrom({ not: "an array" }, asked), {});
  // the model setter refuses non-https too
  const { db, model } = withAssets();
  try {
    assert.equal(model.setAssetIcons({ [USDC]: "http://example.com/usdc.png" }), 0);
    assert.equal(model.assetIconOf(USDC), null); assert.equal(model.knownImage("http://example.com/usdc.png"), false);
    assert.equal(model.assetMapRef(USDC).image, null);
  } finally { db.close(); }
});

test("batches of ASSET_ICON_BATCH, sequential; a failed batch keeps what was stored", async () => {
  const { db, model } = withAssets();
  try {
    // 60 more asset families quoted in mints without metadata
    const extra = Array.from({ length: 60 }, (_, i) => `Mint${String(i).padStart(2, "0")}${"1".repeat(34)}`);
    extra.forEach((q, i) => model.upsertCoin({ mint: `Coin${String(i).padStart(2, "0")}${"2".repeat(34)}`, curve: `CV${i}`, depth: 0, quoteMint: q, ...base, tracked: true, createdAt: 7000 + i }));
    const table = Object.fromEntries([USDC, ...extra].map((m) => [m, { id: m, icon: `https://cdn.example.com/${m}.png` }]));
    const calls = [];
    const r = await refreshAssetIcons({ model, fetchImpl: fakeList(table, calls) });
    assert.equal(r.asked, 61); assert.equal(r.calls, Math.ceil(61 / ASSET_ICON_BATCH)); assert.equal(calls.length, 2); assert.equal(r.found, 61); assert.equal(r.changed, 61);
    // the list is down: nothing is lost, the failures are counted
    const down = await refreshAssetIcons({ model, fetchImpl: async () => { throw new Error("offline"); } });
    assert.equal(down.failed, 2); assert.equal(down.changed, 0);
    assert.equal(model.assetIconOf(USDC), `https://cdn.example.com/${USDC}.png`);
    const http500 = await refreshAssetIcons({ model, fetchImpl: async () => new Response("no", { status: 500 }) });
    assert.equal(http500.failed, 2); assert.equal(model.assetIcons.size, 61);
  } finally { db.close(); }
});

test("startAssetIcons runs once at boot and stops cleanly", async () => {
  const { db, model } = withAssets();
  try {
    const calls = [];
    const job = startAssetIcons({ model, fetchImpl: fakeList({ [USDC]: { id: USDC, icon: ICON } }, calls), bootDelayMs: 0, everyMs: 3_600_000 });
    await new Promise((r) => setTimeout(r, 30));
    job.stop();
    assert.equal(calls.length, 1); assert.equal(model.assetIconOf(USDC), ICON);
  } finally { db.close(); }
});
