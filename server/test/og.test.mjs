// Link previews (lib/og.mjs) and their wiring in api.mjs: the HTML of /c/<mint> and /map?focus=<mint>
// carries that coin's own og:/twitter: tags, every other page keeps the static block, and
// /api/card/<mint>.png serves the card with edge-cache headers. The renderer is injected (`card`),
// so these tests cover the tags and the routes, not the drawing.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, etagMatches, CARD_CACHE, CARD_CACHE_PLACEHOLDER } from "../lib/api.mjs";
import { ogTags, ogTitle, ogDescription, ogImageUrl, ogPath, injectOg, cardMintFor, escapeAttr, oneLine, tickerOf, OG_START, OG_END } from "../lib/og.mjs";
import { EventHub } from "../lib/events.mjs";
import { buildTree, K, PLATFORM, quiet } from "./helpers/tree.mjs";

const PUB = "https://sporepad.test";
const CLOCK = 1_700_000_000_000; // ms; og:image version = floor(CLOCK / 60 000)
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
const STATIC_BLOCK = [
  '    <meta property="og:site_name" content="Spore" />',
  '    <meta property="og:type" content="website" />',
  '    <meta property="og:url" content="/" />',
  '    <meta property="og:title" content="Spore — coins that grow coins" />',
  '    <meta property="og:image" content="/og.png" />',
  '    <meta name="twitter:card" content="summary_large_image" />',
  '    <meta name="twitter:image" content="/og.png" />',
].join("\n");
const INDEX = `<!doctype html><html><head>\n    <title>Spore</title>\n    ${OG_START}\n${STATIC_BLOCK}\n    ${OG_END}\n    <script nonce="__CSP_NONCE__">1</script></head><body><div id="root"></div></body></html>`;

const ROOT_REF = { mint: K.ROOT, name: "ROOT coin", symbol: "ROOT" };
const DATA = {
  [K.A]: { mint: K.A, name: 'AAA <&"> coin', symbol: "AAA", image: null, depth: 1, ours: false, migrated: false, complete: false, createdAt: 2000, mcapUsd: 12_400, lockedUsd: 500, children: 1, descendants: 1,
    parent: ROOT_REF, root: ROOT_REF, lineage: ["$ROOT", "$AAA"], firstborn: true, family: { top: { mint: K.ROOT, symbol: "ROOT" }, under: 3, sharePct: 4.2 } },
  [K.ROOT]: { mint: K.ROOT, name: "ROOT coin", symbol: "ROOT", image: null, depth: 0, ours: false, migrated: false, complete: false, createdAt: 1000, mcapUsd: 1_234_000, lockedUsd: 600, children: 2, descendants: 3,
    parent: null, root: null, lineage: ["$ROOT"], firstborn: false, family: { top: { mint: K.ROOT, symbol: "ROOT" }, under: 3, sharePct: 100 } },
  [K.G]: { mint: K.G, name: "GGG coin", symbol: "GGG", image: null, depth: 2, ours: true, migrated: false, complete: true, createdAt: 4000, mcapUsd: null, lockedUsd: null, children: 0, descendants: 0,
    parent: { mint: K.A, name: "AAA coin", symbol: "AAA" }, root: ROOT_REF, lineage: ["$ROOT", "$AAA", "$GGG"], firstborn: false, family: { top: { mint: K.ROOT, symbol: "ROOT" }, under: 3, sharePct: null } },
  // a depth-0 coin paired with a listed asset: no coin parent, the asset is its family's top (not in the fixture tree: pure tests only)
  [K.U]: { mint: K.U, name: "UUU coin", symbol: "UUU", image: null, depth: 0, ours: false, migrated: false, complete: false, createdAt: 5000, mcapUsd: 322_000, lockedUsd: 40_000, children: 11, descendants: 14,
    parent: null, root: { mint: K.X, name: "Pump", symbol: "PUMP" }, lineage: ["$PUMP", "$UUU"], firstborn: true, family: { top: { mint: K.X, symbol: "PUMP" }, under: 198, sharePct: 4.3 } },
};

let server, base, db, hub, dir, renders = 0, lookups = [], busyMint = null;
const indexer = { fetchCoin: async (mint) => { lookups.push(mint); return null; }, snapshot: () => ({ phase: "test" }), globalRaw: null, quoteControlRaw: null };
/** The fake renderer: G's card is drawn with the placeholder (its logo "is not cached"), `busyMint` finds the render queue full. */
const card = {
  cardData: (m, mint) => (m.get(mint) && DATA[mint]) || null,
  renderCard: async ({ model: m, mint }) => {
    const data = (m.get(mint) && DATA[mint]) || null;
    if (!data) return null;
    if (mint === busyMint) return { busy: true };
    renders++;
    return { png: PNG, etag: `W/"card-${mint.slice(0, 6)}"`, data, placeholder: mint === K.G };
  },
};
/** An app over `model` with the fake renderer and the given per-limiter `rates`, listening on a free port. */
async function boot(model, rates) {
  const app = createApp({ model, indexer, rpc: { proxy: async () => ({ status: 200, text: "{}" }) }, hub, images: { handler: () => (_q, r) => r.status(404).end() }, meta: null,
    platformWallet: PLATFORM, splitBps: [5000, 2500, 1000, 1500], distDir: join(dir, "dist"), log: quiet, publicUrl: PUB, card, now: () => CLOCK, rates });
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  return { server: srv, base: `http://127.0.0.1:${srv.address().port}` };
}
before(async () => {
  const { db: d, model } = buildTree();
  db = d;
  hub = new EventHub({ heartbeatMs: 60_000 });
  dir = mkdtempSync(join(tmpdir(), "spore-og-"));
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "index.html"), INDEX);
  ({ server, base } = await boot(model, { api: { limit: 1000, windowMs: 60_000 }, img: { limit: 1000, windowMs: 60_000 } }));
});
after(() => { hub.close(); server.closeAllConnections?.(); server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

const get = (p, init = {}) => fetch(base + p, init);
const metaOf = (html, attr, key) => { const m = new RegExp(`<meta ${attr}="${key}" content="([^"]*)" />`).exec(html); return m ? m[1] : null; };
const countOf = (html, re) => (html.match(re) ?? []).length;

// ---------------------------------------------------------------- pure
test("ogTitle / ogDescription: child under parent, family top, missing numbers hidden, lineage from depth 2", () => {
  assert.equal(ogTitle(DATA[K.A]), "$AAA under $ROOT · Spore");
  assert.equal(ogTitle(DATA[K.ROOT]), "$ROOT · Spore");
  assert.equal(ogTitle(DATA[K.U]), "$UUU quoted in $PUMP · Spore", "a depth-0 coin paired with a listed asset names it");
  assert.equal(ogDescription(DATA[K.A]), 'AAA <&"> coin · mcap $12.4K · 1 child · $500.00 locked · first child of $ROOT · $ROOT family holds 4.2% of the map');
  assert.equal(ogDescription(DATA[K.ROOT]), "ROOT coin · mcap $1.23M · 3 coins under it · $600.00 locked · 100% of the Spore map", "a top counts everything under it, as the web's share text does");
  assert.equal(ogDescription(DATA[K.U]), "UUU coin · mcap $322K · 11 children · 14 descendants · $40K locked · first coin quoted in $PUMP · $PUMP family holds 4.3% of the map", "the share is the asset family's, never the coin's own");
  assert.equal(ogDescription(DATA[K.G]), "GGG coin · no children yet · $ROOT › $AAA › $GGG", "null mcap and null share leave no trace");
  // the lineage comes from the card data's chain (refs), named with tickerOf: a ticker the card's font cannot draw stays a ticker here
  const chain = [{ mint: K.ROOT, name: "Pumpkin root", symbol: "PUMPE" }, { mint: K.A, name: "Pumpkin", symbol: "🎃" }, { mint: K.G, name: "Seed", symbol: "SEED" }];
  assert.equal(ogDescription({ ...DATA[K.G], chain, lineage: ["$PUMPE", `${K.A.slice(0, 4)}…${K.A.slice(-4)}`, "$SEED"] }), "GGG coin · no children yet · $PUMPE › $🎃 › $SEED", "chain over lineage: no short mint for an emoji ticker");
  assert.equal(ogDescription({ ...DATA[K.G], chain: chain.slice(1) }), "GGG coin · no children yet", "a chain of two says no lineage");
  assert.equal(ogDescription({ ...DATA[K.G], chain: [] }), "GGG coin · no children yet · $ROOT › $AAA › $GGG", "an empty chain falls back to the lineage strings");
  assert.equal(ogDescription({ ...DATA[K.A], lockedUsd: 0.004, mcapUsd: 0.004 }), 'AAA <&"> coin · mcap < $0.01 · 1 child · first child of $ROOT · $ROOT family holds 4.2% of the map', "dust locked: no locked part");
  assert.equal(ogDescription({ ...DATA[K.ROOT], lockedUsd: null, descendants: null }), "ROOT coin · mcap $1.23M · 2 coins under it · 100% of the Spore map", "no descendant count: the children stand in");
  assert.equal(ogDescription({ mint: K.X, name: null, symbol: null }), "A coin on Spore, the pump.fun family-tree launchpad.");
  assert.equal(ogTitle({ mint: K.X, name: null, symbol: null, parent: null }), `${K.X.slice(0, 4)}…${K.X.slice(-4)} · Spore`, "no ticker, no name: the short mint");
  assert.equal(ogTitle({ mint: K.X, name: "Only a name", symbol: "", parent: { symbol: "$P" } }), "Only a name under $P · Spore", "a symbol that already carries $ is not doubled");
});

test("text helpers: one line, ticker (the raw symbol: crawlers draw CJK and emoji that the card's font cannot)", () => {
  assert.equal(oneLine("  a\n\tb\u0000  c  "), "a b c");
  assert.equal(oneLine("x".repeat(20), 10), "xxxxxxxxx…");
  assert.equal(tickerOf({ symbol: " $$kid ", name: "Kid" }), "$kid");
  assert.equal(tickerOf({ symbol: null, name: "Kid Coin" }), "Kid Coin");
  assert.equal(tickerOf({ symbol: "💎", name: "💎", mint: K.X }), "$💎");
  assert.equal(tickerOf({ symbol: null, name: null, mint: K.X }), `${K.X.slice(0, 4)}…${K.X.slice(-4)}`);
});

test("ogTags: every value escaped, og:url canonical, og:image versioned by the minute, twitter card large", () => {
  const tags = ogTags(DATA[K.A], { publicUrl: `${PUB}/`, path: `/c/${K.A}?utm=x&y="z"`, now: CLOCK });
  assert.equal(metaOf(tags, "property", "og:url"), `${PUB}/c/${K.A}`, "extra query parameters never reach the page");
  assert.equal(metaOf(tags, "property", "og:title"), "$AAA under $ROOT · Spore");
  assert.equal(metaOf(tags, "property", "og:description"), "AAA &lt;&amp;&quot;&gt; coin · mcap $12.4K · 1 child · $500.00 locked · first child of $ROOT · $ROOT family holds 4.2% of the map");
  assert.equal(metaOf(tags, "property", "og:image"), `${PUB}/card/${K.A}.png?v=${Math.floor(CLOCK / 60_000)}`);
  assert.equal(metaOf(tags, "property", "og:image:width"), "1200"); assert.equal(metaOf(tags, "property", "og:image:height"), "630");
  assert.equal(metaOf(tags, "property", "og:image:type"), "image/png");
  assert.match(metaOf(tags, "property", "og:image:alt"), /^Family map of \$AAA on Spore: AAA &lt;&amp;&quot;&gt; coin/, "the alt says what the picture is");
  assert.equal(metaOf(tags, "name", "twitter:card"), "summary_large_image");
  assert.equal(metaOf(tags, "name", "twitter:title"), metaOf(tags, "property", "og:title"));
  assert.equal(metaOf(tags, "name", "twitter:description"), metaOf(tags, "property", "og:description"));
  assert.equal(metaOf(tags, "name", "twitter:image"), metaOf(tags, "property", "og:image"));
  assert.equal(metaOf(tags, "property", "og:site_name"), "Spore"); assert.equal(metaOf(tags, "property", "og:type"), "website"); assert.equal(metaOf(tags, "property", "og:locale"), "en_US");
  assert.ok(!tags.includes('<&">'), "raw characters never appear"); assert.ok(!tags.includes("\n\n"));
  for (const line of tags.split("\n")) assert.match(line, /^ {4}<meta (property|name)="[a-z:_]+" content="[^"<>]*" \/>$/, line);
  assert.equal(escapeAttr(`a&b<c>d"e'f`), "a&amp;b&lt;c&gt;d&quot;e&#39;f");
  assert.equal(ogPath("/map?focus=x", K.A), `/map?focus=${K.A}`); assert.equal(ogPath("/map/", K.A), `/map?focus=${K.A}`); assert.equal(ogPath(`/c/${K.A}/`, K.A), `/c/${K.A}`); assert.equal(ogPath(undefined, K.A), `/c/${K.A}`);
  assert.equal(ogImageUrl({ mint: K.A }, { publicUrl: PUB, now: 60_000 }), `${PUB}/card/${K.A}.png?v=1`);
  // A name with a newline and a 5 KB name stay one bounded line.
  const long = ogTags({ ...DATA[K.A], name: `x\ny${"z".repeat(5000)}` }, { publicUrl: PUB, path: "/", now: CLOCK });
  assert.ok(!long.includes("x\ny")); assert.ok(metaOf(long, "property", "og:description").length <= 300);
});

test("injectOg: replaces only the fenced block, keeps the markers; html unchanged without them or with them reversed", () => {
  const out = injectOg(INDEX, "    <meta property=\"og:title\" content=\"T\" />");
  assert.ok(out.includes(OG_START) && out.includes(OG_END));
  assert.ok(!out.includes('content="/og.png"') && !out.includes("Spore — coins that grow coins"), "static block gone");
  assert.ok(out.includes('<meta property="og:title" content="T" />') && out.includes("<title>Spore</title>") && out.includes('nonce="__CSP_NONCE__"'), "the rest untouched");
  assert.equal(injectOg("<html><head></head></html>", "x"), "<html><head></head></html>");
  assert.equal(injectOg(`<head>${OG_START}</head>`, "x"), `<head>${OG_START}</head>`);
  assert.equal(injectOg(`<head>${OG_END} a ${OG_START}</head>`, "x"), `<head>${OG_END} a ${OG_START}</head>`);
});

test("cardMintFor: GET/HEAD /c/<mint> and /map?focus=<mint> only", () => {
  const req = (method, path, query = {}) => ({ method, path, query });
  assert.equal(cardMintFor(req("GET", `/c/${K.A}`)), K.A);
  assert.equal(cardMintFor(req("HEAD", `/c/${K.A}/`)), K.A);
  assert.equal(cardMintFor(req("GET", "/map", { focus: K.B })), K.B);
  assert.equal(cardMintFor(req("GET", "/map/", { focus: K.B })), K.B);
  assert.equal(cardMintFor(req("GET", "/map", { focus: [K.B, K.A] })), null, "repeated parameter");
  assert.equal(cardMintFor(req("GET", "/map", { focus: "not-a-mint" })), null);
  assert.equal(cardMintFor(req("GET", "/map")), null);
  assert.equal(cardMintFor(req("GET", "/c/not-a-mint")), null);
  assert.equal(cardMintFor(req("GET", `/c/${K.A}/trades`)), null);
  assert.equal(cardMintFor(req("GET", `/embed/tree/${K.A}`)), null);
  assert.equal(cardMintFor(req("GET", "/explore")), null);
  assert.equal(cardMintFor(req("POST", `/c/${K.A}`)), null);
  assert.equal(cardMintFor(null), null);
});

test("etagMatches: exact, list, weak/strong, *, nothing", () => {
  assert.ok(etagMatches('W/"a"', 'W/"a"')); assert.ok(etagMatches('"x", W/"a"', 'W/"a"')); assert.ok(etagMatches("*", 'W/"a"'));
  assert.ok(etagMatches('"a"', 'W/"a"'), "a strong validator of the same bytes");
  assert.ok(!etagMatches('W/"b"', 'W/"a"')); assert.ok(!etagMatches(undefined, 'W/"a"')); assert.ok(!etagMatches('W/"a"', null));
});

// ---------------------------------------------------------------- HTTP: the page
test("GET /c/<known>: the coin's tags replace the static block; nonce, CSP and no-cache stay", async () => {
  const r = await get(`/c/${K.A}`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.equal(metaOf(html, "property", "og:title"), "$AAA under $ROOT · Spore");
  assert.equal(metaOf(html, "property", "og:url"), `${PUB}/c/${K.A}`);
  assert.equal(metaOf(html, "property", "og:image"), `${PUB}/card/${K.A}.png?v=${Math.floor(CLOCK / 60_000)}`);
  assert.equal(metaOf(html, "name", "twitter:image"), metaOf(html, "property", "og:image"));
  assert.equal(metaOf(html, "name", "twitter:card"), "summary_large_image");
  assert.equal(metaOf(html, "property", "og:description"), "AAA &lt;&amp;&quot;&gt; coin · mcap $12.4K · 1 child · $500.00 locked · first child of $ROOT · $ROOT family holds 4.2% of the map");
  assert.equal(countOf(html, /property="og:image" /g), 1, "one og:image"); assert.equal(countOf(html, /property="og:title" /g), 1);
  assert.ok(!html.includes('content="/og.png"'), "no leftover static image");
  assert.ok(!html.includes("Spore — coins that grow coins"), "no leftover static title");
  assert.ok(!html.includes('<&">'), "escaped");
  assert.ok(html.includes("<title>Spore</title>") && html.includes('id="root"'), "the rest of the page is intact");
  const nonce = r.headers.get("content-security-policy").match(/'nonce-([^']+)'/)?.[1];
  assert.ok(nonce && html.includes(`<script nonce="${nonce}">`) && !html.includes("__CSP_NONCE__"), "nonce substituted after injection");
  assert.equal(r.headers.get("cache-control"), "no-cache");
  assert.match(r.headers.get("content-type"), /text\/html/);
});

test("GET /map?focus=<known>: same tags, og:url is the map link; HEAD answers too", async () => {
  const r = await get(`/map?focus=${K.ROOT}&zoom=3`);
  const html = await r.text();
  assert.equal(metaOf(html, "property", "og:title"), "$ROOT · Spore");
  assert.equal(metaOf(html, "property", "og:url"), `${PUB}/map?focus=${K.ROOT}`);
  assert.equal(metaOf(html, "property", "og:description"), "ROOT coin · mcap $1.23M · 3 coins under it · $600.00 locked · 100% of the Spore map");
  assert.ok(!html.includes('content="/og.png"'));
  const h = await get(`/c/${K.A}`, { method: "HEAD" });
  assert.equal(h.status, 200); assert.equal(await h.text(), "");
});

test("GET /c/<unknown>, /, /explore, /map without focus: the static block stays, markers intact", async () => {
  for (const p of [`/c/${K.X}`, "/c/not-a-mint", "/", "/explore", "/map", `/map?focus=${K.X}`, `/embed/tree/${K.A}`]) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    const html = await r.text();
    assert.equal(metaOf(html, "property", "og:image"), "/og.png", p);
    assert.equal(metaOf(html, "property", "og:title"), "Spore — coins that grow coins", p);
    assert.ok(html.includes(OG_START) && html.includes(OG_END), p);
    assert.ok(!html.includes("__CSP_NONCE__"), p);
  }
  assert.deepEqual(lookups, [], "the page never waits on a live lookup");
});

// ---------------------------------------------------------------- HTTP: the card
test("GET /api/card/<mint>.png: the PNG with edge-cache, CORS and timing headers; 304 on the ETag; HEAD", async () => {
  const before = renders;
  const r = await get(`/api/card/${K.A}.png`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/png");
  assert.equal(r.headers.get("cache-control"), CARD_CACHE); assert.equal(CARD_CACHE, "public, max-age=60, stale-while-revalidate=300");
  assert.equal(r.headers.get("etag"), `W/"card-${K.A.slice(0, 6)}"`);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  assert.equal(r.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.match(r.headers.get("x-card-ms"), /^\d+$/);
  assert.equal(r.headers.get("content-length"), String(PNG.length));
  assert.equal(r.headers.get("content-encoding"), null, "never compressed");
  assert.match(r.headers.get("x-ratelimit-policy"), /name=img/, "the image limit, not the API one");
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(PNG));
  assert.equal(renders, before + 1);
  const n = await get(`/api/card/${K.A}.png`, { headers: { "if-none-match": `W/"card-${K.A.slice(0, 6)}"` } });
  assert.equal(n.status, 304); assert.equal(n.headers.get("etag"), `W/"card-${K.A.slice(0, 6)}"`); assert.equal(n.headers.get("cache-control"), CARD_CACHE);
  assert.equal((await get(`/api/card/${K.A}.png`, { headers: { "if-none-match": 'W/"other"' } })).status, 200);
  const h = await get(`/api/card/${K.ROOT}.png`, { method: "HEAD" });
  assert.equal(h.status, 200); assert.equal(h.headers.get("content-type"), "image/png"); assert.equal(h.headers.get("content-length"), String(PNG.length)); assert.equal(await h.text(), "");
});

test("GET /api/card/<mint>.png: a card drawn with the placeholder is cached only as long as the renderer keeps it", async () => {
  const r = await get(`/api/card/${K.G}.png`);
  assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "image/png");
  assert.equal(r.headers.get("cache-control"), CARD_CACHE_PLACEHOLDER); assert.equal(CARD_CACHE_PLACEHOLDER, "public, max-age=5");
  assert.ok(!r.headers.get("cache-control").includes("stale-while-revalidate"), "never served stale: the next crawler should get the logo");
  assert.equal(r.headers.get("etag"), `W/"card-${K.G.slice(0, 6)}"`);
  const n = await get(`/api/card/${K.G}.png`, { headers: { "if-none-match": `W/"card-${K.G.slice(0, 6)}"` } });
  assert.equal(n.status, 304); assert.equal(n.headers.get("cache-control"), CARD_CACHE_PLACEHOLDER);
  assert.equal((await get(`/api/card/${K.A}.png`)).headers.get("cache-control"), CARD_CACHE, "a finished card keeps the long cache");
});

test("GET /api/card/<mint>.png: when the render queue is full the answer is the generic card (302 /og.png, uncacheable) while cached cards stay 200 / 304", async () => {
  busyMint = K.ROOT;
  try {
    const r = await get(`/api/card/${K.ROOT}.png`, { redirect: "manual" });
    assert.equal(r.status, 302); assert.equal(r.headers.get("location"), `${PUB}/og.png`);
    assert.equal(r.headers.get("cache-control"), "no-store", "neither the edge nor the crawler keeps the stand-in");
    assert.equal(r.headers.get("retry-after"), "2");
    assert.equal(r.headers.get("etag"), null); assert.equal(r.headers.get("x-card-ms"), null);
    const ok = await get(`/api/card/${K.A}.png`);
    assert.equal(ok.status, 200); assert.equal(ok.headers.get("cache-control"), CARD_CACHE);
    assert.equal((await get(`/api/card/${K.A}.png`, { headers: { "if-none-match": `W/"card-${K.A.slice(0, 6)}"` } })).status, 304);
    const h = await get(`/api/card/${K.ROOT}.png`, { method: "HEAD", redirect: "manual" });
    assert.equal(h.status, 302);
  } finally { busyMint = null; }
  assert.equal((await get(`/api/card/${K.ROOT}.png`)).status, 200, "drawn once the queue has room");
});

test("GET /api/card: 400 for a malformed mint, 404 for an unknown one after one live lookup, 404 without .png", async () => {
  const bad = await get("/api/card/not-a-mint.png");
  assert.equal(bad.status, 400); assert.deepEqual(await bad.json(), { error: "invalid mint" });
  assert.equal((await get(`/api/card/${K.A}.png.png`)).status, 400, "the parameter is everything before the last .png");
  lookups = [];
  const unknown = await get(`/api/card/${K.X}.png`);
  assert.equal(unknown.status, 404); assert.deepEqual(await unknown.json(), { error: "unknown mint" });
  assert.deepEqual(lookups, [K.X], "indexer.fetchCoin tried once");
  assert.equal(unknown.headers.get("cache-control"), "no-store", "errors are never cached");
  assert.equal((await get(`/api/card/${K.A}`)).status, 404);
  assert.equal((await get(`/api/card/${K.A}.jpg`)).status, 404);
});

test("GET /api/card/<unknown>: the live lookup draws on the API bucket, so a scan of made-up mints stops there while known cards keep serving", async () => {
  const { db: d2, model } = buildTree();
  const { server: s2, base: b2 } = await boot(model, { api: { limit: 1, windowMs: 60_000 }, img: { limit: 1000, windowMs: 60_000 } });
  try {
    lookups = [];
    assert.equal((await fetch(`${b2}/api/card/${K.X}.png`)).status, 404, "the one API token pays for one lookup");
    const cut = await fetch(`${b2}/api/card/${K.U}.png`);
    assert.equal(cut.status, 429); assert.match((await cut.json()).error, /rate limited \(api/); assert.ok(cut.headers.get("retry-after"));
    assert.deepEqual(lookups, [K.X], "no chain read for the second one");
    const ok = await fetch(`${b2}/api/card/${K.A}.png`);
    assert.equal(ok.status, 200, "a known coin's card is still served: the image bucket"); assert.match(ok.headers.get("x-ratelimit-policy"), /name=img/);
  } finally { s2.closeAllConnections?.(); s2.close(); d2.close(); }
});

test("GET /card/<mint>.png: the same card outside /api/ (robots.txt closes /api/ to crawlers; og:image points here)", async () => {
  const r = await get(`/card/${K.A}.png`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/png");
  assert.equal(r.headers.get("cache-control"), CARD_CACHE);
  assert.equal((await get(`/card/zzz.png`)).status, 400);
});
