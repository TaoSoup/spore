// The social card (lib/card.mjs): the facts a coin's card states, drawn from the fixture tree
// ROOT → A (first child) → G, ROOT → B, plus an asset-topped family X (listed asset) → U → V; the
// family picture (which bubbles are drawn, how they are sized, packed and fitted: deterministic, no
// overlaps, nothing outside the picture, a 1 500-child family within budget); the 1200×630 PNG it
// renders, its per-mint cache, the letter avatar when a logo is not cached, the rasterize slots and
// the backlog; and that odd data (no USD prices, a Japanese name, markup in a name, an endless
// ticker) never throws or overflows. Set CARD_OUT=<dir> to also write the rendered cards there.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildTree, K, T22, base, PLATFORM, quiet } from "./helpers/tree.mjs";
import { Db } from "../lib/db.mjs";
import { Model, MAP_CACHE_MS } from "../lib/model.mjs";
import { PublicKey } from "../lib/sdk.mjs";
import { renderLogo, pngSize } from "../lib/agents/logo.mjs";
import { ImgWork } from "../lib/meta.mjs";
import { ogDescription } from "../lib/og.mjs";
import { CARD_W, CARD_H, CARD_TTL_MS, CARD_PLACEHOLDER_TTL_MS, CARD_MAX_INFLIGHT, CARD_BUSY, LOGO_PX, MEMBER_LOGO_PX, BUBBLE_CAP, FOCUS_KIDS, PIC, R_SMALLEST, R_FOCUS_MIN, R_FOCUS_DRAWN_MIN, R_KID_SMALLEST, FOCUS_KIDS_KEEP, SVG_MAX_BYTES, cardData, cardSvg, renderCard, resetCards, cardsInflight, cardsBacklog, isFirstborn, earlier, fit, measure, renderable, drawable, tick, label, letterOf, parseFont, fonts, esc, rasterize, pickBubbles, sizeBubbles, packFamily, fitCluster, layoutFamily, convexHull, smoothHull, rimPoints, tickerStyle, TICKER_SIZES, HULL_PAD_IN, HULL_PAD_OUT, HULL_CUT } from "../lib/card.mjs";

const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const OUT = process.env.CARD_OUT || null;
const save = (name, png) => { if (OUT) { mkdirSync(OUT, { recursive: true }); writeFileSync(join(OUT, `${name}.png`), png); } };
const OUR_SHARES = [{ address: "CR", bps: 5000 }, { address: PLATFORM, bps: 5000 }];
const V = new PublicKey(Buffer.alloc(32, 8)).toBase58(); // one more real base58 key beside the helper's K set
/** The "1ST" pill's width on the HUD, as cardSvg's chip() lays it: the mono text with its letter-spacing plus 12 px each side. */
const PILL_W = Math.ceil(measure("1ST", { font: "mono", weight: 500, size: 20, ls: 1.6 }) + 24);

/** The shared fixture plus an asset-topped family: X is a listed asset (a mint, not a coin), U and S are depth-0 coins quoted in it, V (a Spore launch) a child of U. */
function buildFamilies() {
  const { db, model } = buildTree();
  model.setMint({ mint: K.X, decimals: 6, tokenProgram: T22, name: "Asset coin", symbol: "ASSET", uri: null, onchainAt: 1 });
  model.upsertCoin({ mint: K.U, curve: "C_U", depth: 0, quoteMint: K.X, ...base, virtualQuoteReserves: "1000000000000000", realQuoteReserves: "3000000", createdAt: 5000 });
  model.upsertCoin({ mint: K.S, curve: "C_S", depth: 0, quoteMint: K.X, ...base, virtualQuoteReserves: "1000000000000000", realQuoteReserves: "2000000", createdAt: 6000 });
  model.upsertCoin({ mint: V, curve: "C_V", depth: 1, quoteMint: K.U, ...base, virtualQuoteReserves: "500000000000000", realQuoteReserves: "7000000000000", createdAt: 7000, shares: OUR_SHARES, sharesAt: 1 });
  for (const [mint, symbol] of [[K.U, "UUU"], [K.S, "SSS"], [V, "VVV"]]) model.setMint({ mint, decimals: 6, tokenProgram: T22, name: `${symbol} coin`, symbol, uri: null, onchainAt: 1 });
  // ROOT, BBB and GGG name metadata files the tree fixture never fetches: settled here as fetched without an image, so none of
  // their cards is "image pending" (a logo still on its way has its own test)
  for (const symbol of ["ROOT", "BBB", "GGG"]) model.setMeta(`https://ipfs.io/ipfs/${symbol}`, { image: null, description: null, twitter: null, telegram: null, website: null, fetchedAt: 1, ok: true });
  return { db, model };
}
let model, logoPng, logoPng2;
before(async () => {
  ({ model } = buildFamilies());
  logoPng = await renderLogo({ symbol: "AAA", palette: ["#b6ff5c", "#2f8f4e", "#0b1a12"], seed: "card" });
  logoPng2 = await renderLogo({ symbol: "ROOT", palette: ["#ffcf5c", "#8f4e2f", "#1a120b"], seed: "card-root" });
});
/** An image cache double: `thumbs` maps url → PNG; `warmed` records warm asks. */
const fakeImages = (thumbs = {}) => { const warmed = []; let reads = 0; return { warmed, get reads() { return reads; }, thumbBytes(u, w) { reads++; return w === LOGO_PX ? thumbs[u] ?? null : null; }, async warm(urls, w, n) { warmed.push([urls, w, n]); return { n: urls.length, ok: 0, failed: urls.length }; } }; };
/** A synthetic flat family for the layout tests: a top, `n` children (market caps spread), `grand` grandchildren under the first child. */
function synthFamily(n, grand = 0) {
  const nodes = [{ mint: "TOP", parentMint: null, depth: 0, symbol: "TOP", name: "Top", image: null, mcapUsd: 1e6, migrated: false, ours: false, asset: false }];
  for (let i = 0; i < n; i++) nodes.push({ mint: `K${i}`, parentMint: "TOP", depth: 1, symbol: `K${i}`, name: null, image: i % 3 ? `https://ipfs.io/ipfs/k${i}` : null, mcapUsd: i % 7 === 0 ? null : 500 * (n - i), migrated: i % 5 === 0, ours: i % 11 === 0, asset: false });
  for (let i = 0; i < grand; i++) nodes.push({ mint: `G${i}`, parentMint: "K0", depth: 2, symbol: `G${i}`, name: null, image: null, mcapUsd: 100 * (grand - i), migrated: false, ours: false, asset: false });
  return nodes;
}
/** A real-shaped asset family: an asset top (never priced) over `n` depth-0 coins; the first has `kids` children, the first of those `grand` children (depth 2). */
function synthAssetFamily(n, kids = 12, grand = 6) {
  const nodes = [{ mint: "PUMP", parentMint: null, depth: 0, symbol: "PUMP", name: "Pump", image: "https://ipfs.io/ipfs/pump", mcapUsd: null, migrated: false, ours: false, asset: true }];
  for (let i = 0; i < n; i++) nodes.push({ mint: `C${i}`, parentMint: "PUMP", depth: 0, symbol: `C${i}`, name: null, image: i % 4 ? `https://ipfs.io/ipfs/c${i}` : null, mcapUsd: i % 9 === 0 ? 2e5 / (i + 1) : 3000 + 900 * ((i * 7) % 50), migrated: i % 6 === 0, ours: false, asset: false });
  for (let i = 0; i < kids; i++) nodes.push({ mint: `D${i}`, parentMint: "C0", depth: 1, symbol: `D${i}`, name: null, image: null, mcapUsd: 1500 + 400 * i, migrated: false, ours: i === 1, asset: false });
  for (let i = 0; i < grand; i++) nodes.push({ mint: `E${i}`, parentMint: "D0", depth: 2, symbol: `E${i}`, name: null, image: null, mcapUsd: i ? 800 : 9000, migrated: false, ours: false, asset: false });
  return nodes;
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
/** Every pair at least r1 + r2 + 2 apart, every circle inside the picture. */
function assertPacked(circles, what) {
  for (let i = 0; i < circles.length; i++) {
    const a = circles[i];
    assert.ok(a.x - a.r >= PIC.x0 && a.x + a.r <= PIC.x1 && a.y - a.r >= PIC.y0 && a.y + a.r <= PIC.y1, `${what}: ${a.mint} outside the picture (${a.x.toFixed(0)}, ${a.y.toFixed(0)}, r ${a.r.toFixed(0)})`);
    for (let j = i + 1; j < circles.length; j++) { const b = circles[j]; assert.ok(dist(a, b) >= a.r + b.r + 2 - 1e-6, `${what}: ${a.mint} and ${b.mint} overlap (${dist(a, b).toFixed(1)} < ${(a.r + b.r + 2).toFixed(1)})`); }
  }
}

test("cardData: a SOL root, its first child, a non-first child, a grandchild", () => {
  const root = cardData(model, K.ROOT);
  assert.equal(root.symbol, "ROOT"); assert.equal(root.depth, 0); assert.equal(root.parent, null); assert.equal(root.root, null);
  assert.deepEqual(root.lineage, ["$ROOT"]); assert.equal(root.firstborn, false);
  assert.deepEqual(root.chain, [{ mint: K.ROOT, name: "ROOT coin", symbol: "ROOT" }], "the chain is the refs from the top down");
  assert.equal(root.bubbles.nodes.length, 4); assert.equal(root.bubbles.omitted, 0); assert.equal(root.bubbles.total, 4); assert.ok(root.bubbles.valueUsd > 0);
  assert.deepEqual(root.bubbles.nodes.map((n) => [n.mint, n.parentMint, n.depth, n.top, n.focus]).sort(), [[K.A, K.ROOT, 1, false, false], [K.B, K.ROOT, 1, false, false], [K.G, K.A, 2, false, false], [K.ROOT, null, 0, true, true]].sort());
  assert.deepEqual([root.children, root.descendants], [2, 3]);
  assert.ok(root.mcapUsd > 0 && root.lockedUsd > 0, "priced: solUsd is set");
  assert.deepEqual(root.family.top, { mint: K.ROOT, symbol: "ROOT" }); assert.equal(root.family.under, 3, "A, B and G below the top; the top itself is not counted");
  assert.ok(root.family.sharePct > 0 && root.family.sharePct <= 100, String(root.family.sharePct));
  assert.equal(root.image, null); assert.equal(root.ours, false); assert.equal(root.migrated, false);
  const a = cardData(model, K.A);
  assert.equal(a.firstborn, true, "A (createdAt 2000) is ROOT's first child");
  assert.deepEqual(a.parent, { mint: K.ROOT, name: "ROOT coin", symbol: "ROOT" }); assert.deepEqual(a.root, { mint: K.ROOT, name: "ROOT coin", symbol: "ROOT" });
  assert.deepEqual(a.lineage, ["$ROOT", "$AAA"]); assert.equal(a.image, "https://ipfs.io/ipfs/imgA");
  assert.deepEqual([a.children, a.descendants], [1, 1]);
  assert.deepEqual(a.family, root.family, "the same family row as its top");
  const b = cardData(model, K.B);
  assert.equal(b.firstborn, false, "B (createdAt 3000) came second");
  const g = cardData(model, K.G);
  assert.equal(g.firstborn, true, "G is A's only child");
  assert.deepEqual(g.lineage, ["$ROOT", "$AAA", "$GGG"]); assert.equal(g.parent.mint, K.A); assert.equal(g.root.mint, K.ROOT); assert.equal(g.complete, true);
  assert.deepEqual(g.chain.map((c) => c.mint), [K.ROOT, K.A, K.G]);
  assert.deepEqual(g.bubbles.nodes.map((n) => n.mint).sort(), [K.A, K.B, K.G, K.ROOT].sort(), "the whole family, G the focus"); assert.ok(g.bubbles.nodes.find((n) => n.focus).mint === K.G && g.bubbles.nodes.find((n) => n.top).mint === K.ROOT);
});

test("cardData: an asset-topped family (a listed asset above depth-0 coins), unknown and untracked mints", () => {
  const u = cardData(model, K.U);
  assert.equal(u.parent, null, "a coin quoted in a listed asset has no coin parent");
  assert.deepEqual(u.root, { mint: K.X, name: "Asset coin", symbol: "ASSET" }, "its family top is the asset");
  assert.deepEqual(u.lineage, ["$ASSET", "$UUU"]);
  assert.equal(u.firstborn, true, "U (5000) was the first coin quoted in the asset"); assert.equal(cardData(model, K.S).firstborn, false);
  assert.deepEqual(u.family.top, { mint: K.X, symbol: "ASSET" }); assert.equal(u.family.under, 3, "U + S + V below the asset, which is not a coin");
  assert.deepEqual(u.chain, [{ mint: K.X, name: "Asset coin", symbol: "ASSET" }, { mint: K.U, name: "UUU coin", symbol: "UUU" }]);
  const uTop = u.bubbles.nodes.find((n) => n.top);
  assert.deepEqual([uTop.mint, uTop.asset, uTop.mcapUsd, uTop.parentMint], [K.X, true, null, null], "the asset is the top bubble, never priced");
  assert.deepEqual(u.bubbles.nodes.map((n) => n.mint).sort(), [K.X, K.U, K.S, V].sort()); assert.equal(u.bubbles.total, 4);
  const v = cardData(model, V);
  assert.deepEqual(v.lineage, ["$ASSET", "$UUU", "$VVV"]); assert.equal(v.parent.mint, K.U); assert.equal(v.root.mint, K.X);
  assert.equal(v.ours, true, "its split names the platform"); assert.equal(v.firstborn, true);
  assert.equal(cardData(model, "11111111111111111111111111111111"), null);
  assert.equal(cardData(model, "not a mint"), null); assert.equal(cardData(model, null), null);
  // an untracked coin (looked up for its page, nobody spawned under it yet) is a plain root with nothing below it: its link unfurls too
  const { model: m2 } = buildFamilies();
  const FOREIGN = "So11111111111111111111111111111111111111113";
  m2.upsertCoin({ mint: FOREIGN, curve: "C_T", depth: 0, quoteMint: null, ...base, virtualQuoteReserves: "100000000000", createdAt: 9500, tracked: false });
  m2.setMint({ mint: FOREIGN, decimals: 6, tokenProgram: T22, name: "Foreign coin", symbol: "FRGN", uri: null, onchainAt: 1 });
  assert.equal(m2.get(FOREIGN).tracked, false);
  const foreign = cardData(m2, FOREIGN);
  assert.deepEqual([foreign.symbol, foreign.parent, foreign.root, foreign.lineage, foreign.children, foreign.descendants, foreign.firstborn], ["FRGN", null, null, ["$FRGN"], 0, 0, false]);
  assert.deepEqual(foreign.family, { top: { mint: FOREIGN, symbol: "FRGN" }, under: 0, sharePct: null });
  assert.deepEqual(foreign.bubbles, { nodes: [{ ...foreign.bubbles.nodes[0] }], omitted: 0, total: 1, valueUsd: foreign.bubbles.valueUsd }); assert.ok(foreign.bubbles.nodes[0].top && foreign.bubbles.nodes[0].focus, "a lone coin is one bubble");
  assert.ok(foreign.mcapUsd > 0, "priced like any SOL root"); assert.equal(foreign.lockedUsd, null);
  // a spawn whose parent the model has not indexed: named by its parent's mint, never read as a root
  const ORPHAN = "So11111111111111111111111111111111111111115", GHOST = "GhostParent11111111111111111111111111111111";
  m2.upsertCoin({ mint: ORPHAN, curve: "C_O", depth: 1, quoteMint: GHOST, ...base, virtualQuoteReserves: "500000000000000", createdAt: 9000 });
  m2.setMint({ mint: ORPHAN, decimals: 6, tokenProgram: T22, name: "Orphan", symbol: "ORPHAN", uri: null, onchainAt: 1 });
  const orphan = cardData(m2, ORPHAN);
  assert.deepEqual(orphan.parent, { mint: GHOST, name: null, symbol: null }); assert.equal(orphan.root, null);
  assert.deepEqual(orphan.lineage, ["Ghos…1111", "$ORPHAN"]); assert.equal(orphan.firstborn, true, "its parent's only known child");
  assert.deepEqual(orphan.family.top, { mint: GHOST, symbol: null }); assert.equal(orphan.family.under, 1, "what is known under the ghost parent: the orphan"); assert.equal(orphan.family.sharePct, null);
  assert.deepEqual(orphan.bubbles.nodes.map((n) => n.mint), [ORPHAN], "a ghost top is not drawn: the orphan alone"); assert.deepEqual(orphan.chain.map((c) => c.mint), [GHOST, ORPHAN]);
  assert.equal(orphan.mcapUsd, null, "unpriced: the chain does not reach a root");
  const orphanSvg = cardSvg(orphan, {});
  assert.ok(orphanSvg.includes(">under <") && orphanSvg.includes(">Ghos…1111<") && !orphanSvg.includes(">root<"));
  // the family share table follows the map build (one per model version, at most every MAP_CACHE_MS): a new child moves the top's coin count
  m2.upsertCoin({ mint: "So11111111111111111111111111111111111111114", curve: "C_N", depth: 1, quoteMint: K.B, ...base, virtualQuoteReserves: "500000000000000", realQuoteReserves: "1000000000000", createdAt: 8000 });
  m2.now = () => Date.now() + MAP_CACHE_MS + 1;
  assert.equal(cardData(m2, K.ROOT).family.under, 4);
});

test("firstborn rule: earliest createdAt, an undated child only when alone, ties by mint", () => {
  const d = (mint, createdAt) => ({ mint, createdAt });
  assert.equal(isFirstborn(d("b", 10), [d("a", 20), d("b", 10)]), true);
  assert.equal(isFirstborn(d("a", 20), [d("a", 20), d("b", 10)]), false);
  assert.equal(isFirstborn(d("a", null), [d("a", null)]), true, "an undated only child");
  assert.equal(isFirstborn(d("a", null), [d("a", null), d("b", null)]), false, "two undated: no guess");
  assert.equal(isFirstborn(d("b", null), [d("a", null), d("b", 5)]), true, "a dated child beats an undated one");
  assert.equal(isFirstborn(d("a", 7), [d("a", 7), d("b", 7)]), true, "tie: the smaller mint");
  assert.equal(isFirstborn(d("a", 7), []), false);
  assert.equal(earlier(d("x", 1), d("y", 2)), true); assert.equal(earlier(d("y", 2), d("x", 1)), false);
});

test("fonts: the Geist faces load once with real advances; text is measured, cleaned and ellipsised to fit", () => {
  const f = fonts();
  assert.equal(f.buffers.length, 6); assert.equal(fonts(), f, "loaded once");
  const bold = f.metrics["sans:700"], mono = f.metrics["mono:500"];
  assert.equal(bold.upem, 1000); assert.ok(bold.cmap.size > 500 && bold.adv.length > 500);
  assert.equal(mono.adv[mono.cmap.get("M".codePointAt(0))], mono.adv[mono.cmap.get("i".codePointAt(0))], "mono: one advance");
  assert.ok(measure("WWW", { font: "sans", weight: 700, size: 84 }) > measure("iii", { font: "sans", weight: 700, size: 84 }));
  assert.equal(measure("abc", { font: "mono", weight: 400, size: 10, ls: 2 }), 3 * 6 + 3 * 2, "0.6 em per glyph plus letter-spacing");
  assert.equal(measure("", { font: "sans", weight: 400, size: 10 }), 0);
  const st = { font: "sans", weight: 700, size: 84 };
  const long = "SUPERCALIFRAGILISTICEXPIALIDOCIOUS";
  const cut = fit(long, st, 500);
  assert.ok(cut.endsWith("…") && cut.length < long.length, cut); assert.ok(measure(cut, st) <= 500);
  assert.equal(fit("CAT", st, 500), "CAT"); assert.equal(fit(long, st, 1), "");
  assert.equal(renderable(" Hello\u0000  world\t! ", "sans", 400), "Hello world !");
  assert.equal(renderable("かぼす", "sans", 700), "", "no CJK in Geist: stripped, never a tofu box");
  assert.equal(renderable("Ünlü şey €", "sans", 400), "Ünlü şey €");
  assert.deepEqual([tick({ symbol: "$CAT" }), tick({ symbol: null, name: "Just a name" }), tick({ symbol: "かぼす", name: "かぼす", mint: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" })], ["$CAT", "Just a name", "7xKX…gAsU"]);
  assert.deepEqual([label({ symbol: "💎", name: "💎", mint: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" }), label({ symbol: "💎", name: "Gem" })], [{ text: "7xKX…gAsU", address: true }, { text: "Gem", address: false }]);
  assert.equal(esc(`<b>&"it's"`), "&lt;b&gt;&amp;&quot;it&apos;s&quot;");
  assert.throws(() => parseFont(Buffer.alloc(64)), /font/);
});

test("cardSvg: every string escaped, the logo embedded in a clipped circle, the placeholder initial when missing, rows hidden for null USD", () => {
  const data = cardData(model, K.A);
  const withLogo = cardSvg(data, { logo: logoPng });
  assert.match(withLogo, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1200" height="630"/);
  assert.ok(withLogo.includes(`href="data:image/png;base64,${logoPng.toString("base64").slice(0, 40)}`) && /clip-path="url\(#c\d+\)"/.test(withLogo), "the logo clipped to its bubble");
  assert.ok(withLogo.includes('stroke-dasharray="5 5"'), "the ancestor's ring is dashed"); assert.ok(withLogo.includes('fill="url(#grid)"') && withLogo.includes("<line "), "the ground and the links");
  const byLogos = cardSvg(data, { logos: new Map([[K.A, logoPng], [K.ROOT, logoPng]]) });
  assert.equal((byLogos.match(/<use /g) ?? []).length, 2, "every bubble with a logo draws it"); assert.equal((byLogos.match(/<image /g) ?? []).length, 1, "one image behind two bubbles is embedded once");
  assert.ok(/<symbol id="l0" viewBox="0 0 64 64"[^>]*><image width="64" height="64" preserveAspectRatio="xMidYMid slice" href="data:image\/png;base64,/.test(byLogos) && (byLogos.match(/<use href="#l0" /g) ?? []).length === 2, "the symbol and its two uses");
  assert.equal((cardSvg(data, { logos: new Map([[K.A, logoPng], [K.ROOT, logoPng2]]) }).match(/<image /g) ?? []).length, 2, "two different images: two embeds");
  assert.equal(cardSvg(data, { logos: new Map([[K.A, Buffer.from("junk")]]) }).includes("<image "), false, "junk is a letter avatar");
  assert.ok(withLogo.includes(">$AAA<") && withLogo.includes(">AAA coin<") && withLogo.includes(">1ST<") && withLogo.includes(">$ROOT<"), "ticker, name, 1st pill, parent");
  assert.ok(withLogo.includes(">MCAP<") && withLogo.includes(">LOCKED BY CHILDREN<") && withLogo.includes(">CHILDREN<") && !withLogo.includes("DESCENDANTS"), "one child and nothing deeper: a single CHILDREN column");
  const leaf = cardSvg(cardData(model, K.G), {});
  assert.ok(!leaf.includes(">CHILDREN<") && !leaf.includes(">0 / 0<") && leaf.includes(">3 coins under it<"), "a leaf shows no children column; the family block says where it sits");
  assert.ok(!withLogo.includes(">AGE<"), "no clock given: no age column");
  const aged = cardSvg(data, { logo: logoPng, now: 2000 * 1000 + 3 * 86400 * 1000 });
  assert.ok(aged.includes(">AGE<") && aged.includes(">3d<"), "createdAt 2000 s, three days later");
  assert.ok(withLogo.includes("sporepad.com") && withLogo.includes("pump.fun pair") && withLogo.includes(">spore<"));
  const placeholder = cardSvg(cardData(model, K.B), { logo: null, host: "example.test" });
  assert.ok(!placeholder.includes("<image") && placeholder.includes(">B<"), "the ticker's initial in the bubble");
  assert.ok(!placeholder.includes(">1ST<") && placeholder.includes("example.test"));
  // an emoji ticker and name the mono face cannot draw: the bubble shows the mint's first character, never an empty disc
  const { model: mEmoji } = buildFamilies();
  mEmoji.setMint({ mint: K.B, decimals: 6, tokenProgram: T22, name: "🎃", symbol: "🎃", uri: null, onchainAt: 1 });
  const pumpkin = cardSvg(cardData(mEmoji, K.B), {});
  assert.equal(letterOf({ symbol: "🎃", name: "🎃" }), "");
  assert.ok(pumpkin.includes(`>${K.B[0]}<`) && pumpkin.includes(`>${K.B.slice(0, 4)}…${K.B.slice(-4)}<`), "the mint's first character in the disc, the short mint in the HUD");
  const root = cardSvg(cardData(model, K.ROOT), {});
  assert.ok(root.includes(">root<") && root.includes(">SOL<") && root.includes(">$ROOT<") && root.includes(">3 coins under it<") && root.includes("% of the map"), root.slice(-600));
  assert.ok(root.includes(">· 3 coins · ") && root.includes("of the map<"), "the top's title tail counts the family and its share");
  assert.ok(root.includes(">CHILDREN / DESCENDANTS<") && root.includes(">2 / 3<"), "both counts when the family goes deeper");
  const asset = cardSvg(cardData(model, K.U), {});
  assert.ok(asset.includes(">quoted in <") && asset.includes(">$ASSET<"));
  const ours = cardSvg(cardData(model, V), {});
  assert.ok(ours.includes(">LAUNCHED ON SPORE<") && ours.includes('stroke="#b6ff5c" stroke-width="3"'), "lime ring and chip for a Spore launch");
  assert.ok(cardSvg(cardData(model, K.U), {}).includes('stroke="#b6ff5c" stroke-opacity="0.95" stroke-width="1.6"'), "V's beacon ring on another member's card");
  assert.ok(ours.includes(">$UUU<") && ours.includes(">$ASSET<") && ours.includes("· under "), "under $UUU · under $ASSET");
  // markup in a name and ticker never reaches the svg unescaped
  const { model: m2 } = buildFamilies();
  m2.setMint({ mint: K.B, decimals: 6, tokenProgram: T22, name: `<script>alert("x")</script> & co`, symbol: `B"<x>`, uri: null, onchainAt: 1 });
  const evil = cardSvg(cardData(m2, K.B), {});
  assert.ok(!evil.includes("<script") && evil.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co") && evil.includes(">$B&quot;&lt;x&gt;<"));
  // no prices at all (no SOL/USD rate): the mcap and locked rows disappear, the counts stay
  const { model: m3 } = (() => { const db = new Db(":memory:"); const m = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 2500, 1000, 1500], log: quiet }); m.load(); m.upsertCoin({ mint: K.ROOT, curve: "C_ROOT", depth: 0, quoteMint: null, ...base, virtualQuoteReserves: "100000000000" }); m.setMint({ mint: K.ROOT, decimals: 6, tokenProgram: T22, name: "Lonely", symbol: "LONE", uri: null, onchainAt: 1 }); return { model: m }; })();
  const lone = cardData(m3, K.ROOT);
  assert.equal(lone.mcapUsd, null); assert.equal(lone.lockedUsd, null); assert.equal(lone.family.sharePct, null); assert.equal(lone.family.under, 0);
  const svg = cardSvg(lone, {});
  assert.ok(!svg.includes(">MCAP<") && !svg.includes(">LOCKED BY CHILDREN<") && !svg.includes(">CHILDREN<") && !svg.includes(">0 / 0<") && svg.includes("no children yet"), "no dead 0 / 0 column");
  // dust locked under a cent is hidden, as the og:description hides it
  assert.ok(!cardSvg({ ...cardData(model, K.A), lockedUsd: 0.004 }, {}).includes(">LOCKED BY CHILDREN<") && cardSvg({ ...cardData(model, K.A), lockedUsd: 0.02 }, {}).includes(">LOCKED BY CHILDREN<"));
});

test("renderCard: a logo warm() would skip (its failure memory) is still made the way /api/img makes it: get() + thumb()", async () => {
  resetCards();
  const t0 = 1_700_000_000_000, url = "https://ipfs.io/ipfs/imgA";
  const ref = await renderCard({ model, images: fakeImages({ [url]: logoPng }), mint: K.A, now: t0 });
  resetCards();
  let made = null; const calls = [];
  const images = {
    thumbBytes: (u, w) => (u === url && w === LOGO_PX ? made : null),
    async warm(urls) { calls.push(["warm", urls]); return { n: 1, ok: 0, failed: 1, skipped: 1 }; },
    async get(u) { calls.push(["get", u]); return u === url ? { file: "/x/imgA", type: "image/png" } : null; },
    async thumb(u, hit, w) { calls.push(["thumb", u, hit.file, w]); made = logoPng; return { file: "/x/imgA.w256.png", type: "image/png", thumb: w }; },
  };
  const a = await renderCard({ model, images, mint: K.A, now: t0, logoWaitMs: 500 });
  assert.deepEqual(calls, [["get", url], ["thumb", url, "/x/imgA", LOGO_PX]], "the proxy's path, never warm()");
  assert.equal(a.etag, ref.etag, "the logo is in the picture");
  // a dead upstream (get() null, the cache's own negative memory) is the placeholder, and thumb() is never asked
  resetCards(); calls.length = 0; made = null;
  const dead = { ...images, async get(u) { calls.push(["get", u]); return null; } };
  const d = await renderCard({ model, images: dead, mint: K.A, now: t0, logoWaitMs: 500 });
  assert.deepEqual(calls, [["get", url]]); assert.notEqual(d.etag, ref.etag);
});

test("renderCard: a 1200×630 PNG, the same bytes and etag within the TTL, a re-render after it, concurrent asks share one render", async () => {
  resetCards();
  const images = fakeImages({ "https://ipfs.io/ipfs/imgA": logoPng });
  const t0 = 1_700_000_000_000;
  const [a, b] = await Promise.all([renderCard({ model, images, mint: K.A, now: t0 }), renderCard({ model, images, mint: K.A, now: t0 })]);
  assert.ok(Buffer.isBuffer(a.png)); assert.deepEqual(a.png.subarray(0, 8), PNG_MAGIC);
  assert.deepEqual(pngSize(a.png), { width: CARD_W, height: CARD_H });
  assert.match(a.etag, /^"[A-Za-z0-9_-]{20}"$/); assert.equal(a.data.mint, K.A);
  assert.equal(b, a, "concurrent asks share the render"); const reads = images.reads; assert.ok(reads >= 1 && reads <= 2, "one logo, read once or twice (a size standing in)");
  save("first-child-AAA", a.png);
  const c = await renderCard({ model, images, mint: K.A, now: t0 + CARD_TTL_MS - 1 });
  assert.equal(c, a, "served from the cache within the TTL"); assert.equal(c.etag, a.etag); assert.equal(images.reads, reads);
  const d = await renderCard({ model, images, mint: K.A, now: t0 + CARD_TTL_MS + 1 });
  assert.notEqual(d, a, "rendered again after the TTL"); assert.equal(images.reads, 2 * reads);
  assert.equal(d.etag, a.etag, "the same picture, the same validator");
  assert.deepEqual(images.warmed, [], "a cached logo is never warmed");
  assert.equal(await renderCard({ model, images, mint: "11111111111111111111111111111111", now: t0 }), null);
  const root = await renderCard({ model, images: null, mint: K.ROOT, now: t0 });
  assert.deepEqual(pngSize(root.png), { width: CARD_W, height: CARD_H }); save("root-ROOT", root.png);
  const ours = await renderCard({ model, images, mint: V, now: t0, publicUrl: "https://sporepad.com/" });
  assert.deepEqual(pngSize(ours.png), { width: CARD_W, height: CARD_H }); save("ours-VVV", ours.png);
});

test("renderCard: a logo that is not cached draws the placeholder, asks the cache to warm it and is retried sooner", async () => {
  resetCards();
  const images = fakeImages({});
  const t0 = 1_700_000_000_000;
  const a = await renderCard({ model, images, mint: K.A, now: t0, logoWaitMs: 0 });
  assert.deepEqual(pngSize(a.png), { width: CARD_W, height: CARD_H });
  assert.equal(images.warmed.length, 1); assert.deepEqual(images.warmed[0][0], ["https://ipfs.io/ipfs/imgA"]); assert.ok([LOGO_PX, MEMBER_LOGO_PX].includes(images.warmed[0][1]) && images.warmed[0][2] === 1, "one warm ask for the shared coin's thumbnail");
  assert.equal(a.placeholder, true, "the shared coin's logo is missing: the short TTL");
  save("placeholder-AAA", a.png);
  assert.equal(await renderCard({ model, images, mint: K.A, now: t0 + CARD_PLACEHOLDER_TTL_MS - 1, logoWaitMs: 0 }), a, "kept for the short TTL");
  // the thumbnail lands: the next ask after the short TTL draws it (and the svg differs: an <image> now)
  images.thumbBytes = (u, w) => (w === LOGO_PX && u === "https://ipfs.io/ipfs/imgA" ? logoPng : null);
  const b = await renderCard({ model, images, mint: K.A, now: t0 + CARD_PLACEHOLDER_TTL_MS + 1, logoWaitMs: 0 });
  assert.notEqual(b, a); assert.notEqual(b.etag, a.etag, "a different picture once the logo is in");
  // a wait that is given gets the logo when the warm lands in time
  resetCards();
  let landed = false;
  const slow = { thumbBytes: () => (landed ? logoPng : null), async warm() { await new Promise((r) => setTimeout(r, 20)); landed = true; return { ok: 1 }; } };
  const c = await renderCard({ model, images: slow, mint: K.A, now: t0, logoWaitMs: 500 });
  assert.equal(c.etag, b.etag, "waited for the warm, drew the logo");
  // a cache that throws or returns junk is a placeholder, never an error
  resetCards();
  const broken = { thumbBytes: () => { throw new Error("disk"); }, warm: async () => { throw new Error("net"); } };
  assert.deepEqual(pngSize((await renderCard({ model, images: broken, mint: K.A, now: t0, logoWaitMs: 0 })).png), { width: CARD_W, height: CARD_H });
  resetCards();
  const junk = { thumbBytes: () => Buffer.from("not a png at all, but long enough to pass") };
  const j = await renderCard({ model, images: junk, mint: K.A, now: t0, logoWaitMs: 0 });
  assert.deepEqual(pngSize(j.png), { width: CARD_W, height: CARD_H });
});

test("renderCard: a 40-character Japanese name and ticker, an endless ticker and null prices render without a throw or an overflow", async () => {
  resetCards();
  const { model: m } = buildFamilies();
  const jp = "かぼす".repeat(13) + "か"; // 40 characters
  assert.equal([...jp].length, 40);
  m.setMint({ mint: K.B, decimals: 6, tokenProgram: T22, name: jp, symbol: "かぼす", uri: null, onchainAt: 1 });
  const data = cardData(m, K.B);
  assert.equal(data.name, jp); assert.equal(data.symbol, "かぼす");
  const svg = cardSvg(data, {});
  assert.ok(!svg.includes("か"), "glyphs the font lacks are not drawn (no tofu)");
  assert.ok(svg.includes(`>${K.B.slice(0, 4)}…${K.B.slice(-4)}<`), "the short mint stands in for the ticker");
  assert.ok(svg.includes(`font-family="Geist Mono" font-weight="500" font-size="40">`), "set as an address, not as a 60 px name");
  assert.equal(letterOf({ symbol: "かぼす", name: jp }), "", "no letter avatar from a script the mono face lacks"); assert.equal(letterOf({ symbol: "$cat" }), "C"); assert.equal(letterOf({ symbol: null, name: " zed" }), "Z");
  const r = await renderCard({ model: m, images: null, mint: K.B, now: 1 });
  assert.deepEqual(pngSize(r.png), { width: CARD_W, height: CARD_H }); save("japanese-name", r.png);
  // a pump.fun-length ticker (10 characters) is set smaller, never cut: the HUD headline and the picture label say the same
  assert.deepEqual(TICKER_SIZES, [60, 52, 46, 40]);
  for (const sym of ["SOXSTORAH", "BeforeGTA6", "NORMLAMBO", "BUREAUCAT"]) {
    m.setMint({ mint: K.G, decimals: 6, tokenProgram: T22, name: `${sym} coin`, symbol: sym, uri: null, onchainAt: 1 });
    const data = cardData(m, K.G), svg = cardSvg(data, {});
    assert.equal(data.firstborn, true, "G is A's only child: the pill counts in the size choice");
    const st = tickerStyle(`$${sym}`, 400, 18 + PILL_W);
    assert.ok(measure(`$${sym}`, st) <= 400 && st.size <= 60 && st.size <= tickerStyle(`$${sym}`, 400).size, `${sym}: ${st.size} px fits the column`);
    assert.ok(svg.includes(`font-family="Geist" font-weight="700" font-size="${st.size}"><tspan fill="#e8f3e8">$${sym}</tspan>`), `${sym} in full at ${st.size} px`);
    assert.ok(![...svg.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].some((x) => x[1].startsWith(`$${sym.slice(0, 4)}`) && x[1].endsWith("…")), `${sym} is never ellipsised`);
    if (measure(`$${sym}`, { font: "sans", weight: 700, size: 60 }) > 400) assert.ok(st.size < 60, `${sym} was too wide at 60 px`);
  }
  assert.ok(measure("$SOXSTORAH", { font: "sans", weight: 700, size: 60 }) > 400, "the case: too wide at 60 px");
  assert.equal(tickerStyle("$" + "W".repeat(40), 400).size, 40, "past every size the smallest stays and fit() cuts");
  m.setMint({ mint: K.G, decimals: 6, tokenProgram: T22, name: "The Longest Coin Name Anyone Has Ever Typed Into pump dot fun Today Honestly", symbol: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", uri: null, onchainAt: 1 });
  const g = cardSvg(cardData(m, K.G), {});
  const texts = [...g.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map((x) => x[1]);
  assert.ok(texts.some((t) => t.endsWith("…")), "something was ellipsised");
  assert.ok(texts.every((t) => !t.includes("Honestly")), "the long name was cut");
  const png = await rasterize(g);
  assert.deepEqual(pngSize(png), { width: CARD_W, height: CARD_H }); save("long-ticker", png);
});

test("the HUD ticker: a firstborn's pill counts in the size choice (set smaller, kept beside the ticker) and the lineage keeps both parent and root", () => {
  const base = cardData(model, V); // a firstborn under UUU, quoted in the asset
  const data = { ...base, symbol: "PUMPONB", name: "Pump on board", parent: { ...base.parent, symbol: "onboardinu" }, root: { ...base.root, symbol: "PUMP" }, chain: [{ ...base.chain[0], symbol: "PUMP" }, { ...base.chain[1], symbol: "onboardinu" }, { ...base.chain[2], symbol: "PUMPONB" }], lineage: ["$PUMP", "$onboardinu", "$PUMPONB"] };
  const pillW = 18 + PILL_W; // the gap and the pill, as cardSvg lays them
  assert.equal(tickerStyle("$PUMPONB", 400).size, 60, "alone it fits at 60");
  const st = tickerStyle("$PUMPONB", 400, pillW);
  assert.ok(st.size < 60 && measure("$PUMPONB", st) + pillW <= 400, `with the pill it is set at ${st.size}`);
  assert.equal(tickerStyle("$" + "W".repeat(12), 400, pillW).size, tickerStyle("$" + "W".repeat(12), 400).size, "a ticker the pill never fits beside keeps its own size");
  const svg = cardSvg(data, {});
  const pills = [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>(?:<tspan[^>]*>)?1ST</g)].map((m) => [+m[1], +m[2]]);
  assert.equal(pills.length, 2, "one pill on the HUD, one by the focus bubble");
  const hud = pills.filter(([x]) => x < 460); assert.equal(hud.length, 1);
  assert.ok(hud[0][1] < 170, `the HUD pill sits on the headline (y ${hud[0][1]}), not on the lineage line`);
  const lineage = svg.match(/<text x="52" y="[\d.]+"[^>]*font-size="2[24]"[^>]*>(<tspan fill="#b6ff5c">↳ <\/tspan>.*?)<\/text>/)?.[1] ?? "";
  assert.ok(lineage.includes(">$onboardinu<") && lineage.includes(">$PUMP<"), `the lineage names parent and root: ${lineage}`);
  assert.ok(lineage.includes("under </tspan><tspan fill=\"#c6d9c9\">$onboardinu</tspan><tspan fill=\"#8ea596\"> · </tspan>"), "two long tickers: the short form, the root after a dot");
  const { parts: shortData } = { parts: { ...data, parent: { ...data.parent, symbol: "onb" } } };
  const svg2 = cardSvg(shortData, {});
  assert.ok(svg2.includes("> · under </tspan><tspan fill=\"#c6d9c9\">$PUMP</tspan>"), "a short parent: the full line");
});

test("the picture and the text under it count the family the same way: 'N coins under it' on the card's family line and in the og:description", () => {
  for (const [mint, n] of [[K.ROOT, 3], [K.A, 3], [K.U, 3]]) {
    const data = cardData(model, mint), svg = cardSvg(data, {});
    assert.equal(data.family.under, n, mint);
    assert.ok(svg.includes(`>${n} coins under it<`), `card ${mint}: ${svg.slice(-700)}`);
    assert.ok(!svg.includes(`${n + 1} coins`), "the top itself is never counted");
  }
  const og = ogDescription(cardData(model, K.ROOT));
  assert.ok(og.includes("3 coins under it"), og);
  assert.equal(ogDescription(cardData(model, K.U)).includes("coins under it"), false, "a member's description counts its children, not the family");
  // a family of one is "no children yet" on both
  const { model: m } = buildFamilies();
  const LONE = "So11111111111111111111111111111111111111113";
  m.upsertCoin({ mint: LONE, curve: "C_L", depth: 0, quoteMint: null, ...base, virtualQuoteReserves: "100000000000", createdAt: 9500 });
  m.setMint({ mint: LONE, decimals: 6, tokenProgram: T22, name: "Lone", symbol: "LONE", uri: null, onchainAt: 1 });
  const lone = cardData(m, LONE);
  assert.ok(cardSvg(lone, {}).includes("no children yet") && ogDescription(lone).includes("no children yet"));
});

test("a ticker or name the font can only draw part of is not shown cut: the symbol falls through to the name, then the short mint; a half-drawable name line is left out", () => {
  const M = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  assert.equal(drawable("Pure Latin", "sans", 700), "Pure Latin"); assert.equal(drawable("日本CAT", "sans", 700), ""); assert.equal(drawable("Cat 🐱", "sans", 400), ""); assert.equal(drawable("", "sans", 400), "");
  assert.deepEqual(label({ symbol: "日本CAT", name: "Pure Latin", mint: M }), { text: "Pure Latin", address: false }, "a mixed-script ticker is not '$CAT'");
  assert.deepEqual(label({ symbol: "日本CAT", name: "三倍做空 Torah", mint: M }), { text: "7xKX…gAsU", address: true }, "nor is a mixed-script name 'Torah'");
  assert.deepEqual(label({ symbol: "SOXS", name: "三倍做空半导体TORAH", mint: M }), { text: "$SOXS", address: false });
  const { model: m } = buildFamilies();
  m.setMint({ mint: K.B, decimals: 6, tokenProgram: T22, name: "三倍做空半导体 Torah Coin", symbol: "SOXS", uri: null, onchainAt: 1 });
  const svg = cardSvg(cardData(m, K.B), {});
  assert.ok(svg.includes(">$SOXS<") && !svg.includes("Torah") && !svg.includes("三"), "the drawable ticker, no cut name line, no tofu");
  m.setMint({ mint: K.B, decimals: 6, tokenProgram: T22, name: "Torah Coin", symbol: "日本CAT", uri: null, onchainAt: 1 });
  const byName = cardSvg(cardData(m, K.B), {});
  assert.ok(byName.includes(">Torah Coin<") && !byName.includes("CAT") && !byName.includes("日"), "titled by its name, never '$CAT'");
  // the same rule names a parent on a child's lineage line
  m.setMint({ mint: K.A, decimals: 6, tokenProgram: T22, name: "Child", symbol: "KID", uri: null, onchainAt: 1 });
  m.setMint({ mint: K.ROOT, decimals: 6, tokenProgram: T22, name: "Root 🌱", symbol: "ROOT🌱", uri: null, onchainAt: 1 });
  const child = cardSvg(cardData(m, K.A), {});
  assert.ok(child.includes(`>${K.ROOT.slice(0, 4)}…${K.ROOT.slice(-4)}<`) && !child.includes(">$ROOT<") && !child.includes("Root <"), child.slice(0, 200));
});

test("renderCard draws on the image worker thread when the cache has one, and the worker's card is the same bytes as the in-process one", async () => {
  resetCards();
  const work = new ImgWork({ log: quiet });
  const calls = [];
  const images = { ...fakeImages({ "https://ipfs.io/ipfs/imgA": logoPng }), work: { card: async (a) => { calls.push(a); return work.card(a); } } };
  try {
    const t0 = 1_700_000_000_000;
    const out = await renderCard({ model, images, mint: K.A, now: t0 });
    assert.equal(calls.length, 1, "one card job on the worker"); assert.match(calls[0].svg, /^<svg /);
    assert.deepEqual(pngSize(out.png), { width: CARD_W, height: CARD_H }); assert.equal(out.placeholder, false);
    assert.equal(Buffer.compare(out.png, await rasterize(calls[0].svg)), 0, "the worker and the loop draw the same picture");
    assert.equal(work.stats.inline, 0, "a real thread"); assert.ok(work.stats.jobs >= 1);
    assert.equal(await renderCard({ model, images, mint: K.A, now: t0 + 1 }), out, "cached: no second job"); assert.equal(calls.length, 1);
    // a worker that fails the job (it died mid-card) costs that one card an in-process draw, never an error
    resetCards();
    const dying = { ...images, work: { card: async () => { throw Object.assign(new Error("image worker failed: exited (1)"), { transient: true }); } } };
    const again = await renderCard({ model, images: dying, mint: K.A, now: t0 });
    assert.equal(again.etag, out.etag, "the same picture, drawn here");
    const junk = { ...images, work: { card: async () => Buffer.from("not a png") } };
    resetCards();
    assert.equal((await renderCard({ model, images: junk, mint: K.A, now: t0 })).etag, out.etag);
  } finally { work.close(); }
});

test("renderCard: past maxInflight rasterizing cards the (n+1)th is CARD_BUSY while cached cards keep serving; the refused card is drawn in the background and the next ask finds it", async () => {
  resetCards();
  const t0 = 1_700_000_000_000;
  const cached = await renderCard({ model, images: null, mint: K.ROOT, now: t0 });
  const real = cached.png;
  let release; const gate = new Promise((r) => { release = r; });
  let jobs = 0;
  const slow = { thumbBytes: () => null, work: { card: async () => { jobs++; await gate; return real; } } };
  assert.equal(cardsInflight(), 0);
  const a = renderCard({ model, images: slow, mint: K.A, now: t0, maxInflight: 2 });
  const b = renderCard({ model, images: slow, mint: K.B, now: t0, maxInflight: 2 });
  await new Promise((r) => setTimeout(r, 5)); // both reach the rasterizer
  assert.equal(cardsInflight(), 2);
  assert.equal(await renderCard({ model, images: slow, mint: K.G, now: t0, maxInflight: 2 }), CARD_BUSY, "the third card is refused, not queued in the request");
  assert.ok(CARD_BUSY.busy && !CARD_BUSY.png);
  assert.equal(cardsBacklog(), 1, "but remembered for the background");
  assert.equal(await renderCard({ model, images: slow, mint: K.ROOT, now: t0 + 1, maxInflight: 2 }), cached, "a cached card is served regardless");
  const a2 = renderCard({ model, images: slow, mint: K.A, now: t0, maxInflight: 2 }); // joins A's render: not a third one
  assert.equal(cardsInflight(), 2); assert.equal(jobs, 2);
  release();
  const [ra, rb, ra2] = await Promise.all([a, b, a2]);
  assert.equal(ra2, ra, "a second ask for a card in flight shares it");
  assert.equal(Buffer.compare(ra.png, real), 0); assert.equal(Buffer.compare(rb.png, real), 0);
  await new Promise((r) => setTimeout(r, 5)); // the backlog drains once a slot is free
  assert.equal(cardsBacklog(), 0); assert.equal(jobs, 3, "the refused card was drawn in the background"); assert.equal(cardsInflight(), 0);
  const g = await renderCard({ model, images: slow, mint: K.G, now: t0 + 1, maxInflight: 2 });
  assert.ok(g.png && Buffer.compare(g.png, real) === 0, "served from the cache, no fourth job"); assert.equal(jobs, 3);
  assert.equal(CARD_MAX_INFLIGHT, 8);
});

test("renderCard: the slot wraps only the rasterize step: 8 cards waiting for a cold logo never block a 9th whose logos are on disk", async () => {
  resetCards();
  const t0 = 1_700_000_000_000;
  const { model: m } = buildFamilies();
  const mints = [];
  for (let i = 0; i < 8; i++) {
    const mint = new PublicKey(Buffer.alloc(32, 100 + i)).toBase58();
    m.upsertCoin({ mint, curve: `C_${i}`, depth: 1, quoteMint: K.ROOT, ...base, virtualQuoteReserves: "1000000000000000", realQuoteReserves: "10000000000000", createdAt: 3000 + i });
    m.setMint({ mint, decimals: 6, tokenProgram: T22, name: `Slow ${i}`, symbol: `SLOW${i}`, uri: `https://ipfs.io/ipfs/slow${i}`, onchainAt: 1 });
    m.setMeta(`https://ipfs.io/ipfs/slow${i}`, { image: `https://ipfs.io/ipfs/imgSlow${i}`, description: null, twitter: null, telegram: null, website: null, fetchedAt: 1, ok: true });
    mints.push(mint);
  }
  let release; const gate = new Promise((r) => { release = r; });
  // every logo is "being made" behind the gate; A's is on disk
  const images = { thumbBytes: (u, w) => (u === "https://ipfs.io/ipfs/imgA" && w === LOGO_PX ? logoPng : null), async get() { await gate; return null; }, async thumb() { return null; } };
  const slow = mints.map((mint) => renderCard({ model: m, images, mint, now: t0, logoWaitMs: 10_000, maxInflight: CARD_MAX_INFLIGHT }));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(cardsInflight(), 0, "eight logo waits hold no slot");
  const quick = await renderCard({ model: m, images, mint: K.A, now: t0, maxInflight: CARD_MAX_INFLIGHT });
  assert.ok(quick.png && !quick.busy, "the ninth card is drawn at once"); assert.equal(quick.placeholder, false);
  release();
  const outs = await Promise.all(slow);
  assert.ok(outs.every((o) => o.png && o.placeholder === true), "the eight render once their wait ends, with letter avatars");
});

test("renderCard: a cold top logo and a cold shared-coin logo are made at once and waited for together, one wait in all", async () => {
  resetCards();
  const t0 = 1_700_000_000_000;
  const { model: m } = buildFamilies();
  m.setMint({ mint: K.ROOT, decimals: 6, tokenProgram: T22, name: "ROOT coin", symbol: "ROOT", uri: "https://ipfs.io/ipfs/metaRoot", onchainAt: 1 });
  m.setMeta("https://ipfs.io/ipfs/metaRoot", { image: "https://ipfs.io/ipfs/imgRoot", description: null, twitter: null, telegram: null, website: null, fetchedAt: 1, ok: true });
  const data = cardData(m, K.A);
  assert.ok(data.bubbles.nodes.find((n) => n.top).image && data.bubbles.nodes.find((n) => n.focus).image, "both the top and the shared coin have a logo to make");
  const gets = [];
  const images = { thumbBytes: () => null, async get(u) { gets.push([u, performance.now()]); await new Promise((r) => setTimeout(r, 10_000).unref()); return null; }, async thumb() { return null; } };
  const t = performance.now();
  const out = await renderCard({ model: m, images, mint: K.A, now: t0, logoWaitMs: 150 });
  const waited = performance.now() - t;
  assert.ok(out.png && out.placeholder === true, "both missing: the placeholder card");
  assert.equal(gets.length, 2, "both logos asked for"); assert.ok(Math.abs(gets[0][1] - gets[1][1]) < 50, "asked for at once, not one after the other");
  assert.ok(waited >= 140 && waited < 1_000, `one wait of 150 ms, not two: ${waited.toFixed(0)} ms`);
});

test("renderCard: a shared coin (or a top) with no image yet while its metadata is still being fetched is a placeholder card: the short TTL, not a minute", async () => {
  resetCards();
  const t0 = 1_700_000_000_000, uri = "https://ipfs.io/ipfs/pendingB";
  const { model: m } = buildFamilies();
  m.setMint({ mint: K.B, decimals: 6, tokenProgram: T22, name: "BBB coin", symbol: "BBB", uri, onchainAt: 1 }); // a uri the fetcher has not resolved
  const data = cardData(m, K.B);
  assert.equal(data.image, null); assert.equal(data.imagePending, true); assert.equal(data.bubbles.nodes.find((n) => n.focus).imagePending, true);
  assert.equal(cardData(m, K.A).imagePending, false, "a coin with an image"); assert.equal(cardData(m, K.ROOT).imagePending, false, "metadata fetched, no image: nothing will come");
  const images = fakeImages({});
  const a = await renderCard({ model: m, images, mint: K.B, now: t0, logoWaitMs: 0 });
  assert.equal(a.placeholder, true, "the logo may land any moment"); assert.ok(images.warmed.every(([urls]) => !urls.some((u) => u.includes("pending"))), "nothing of B's to warm yet: no image url (A's member logo is)");
  assert.equal(await renderCard({ model: m, images, mint: K.B, now: t0 + CARD_PLACEHOLDER_TTL_MS - 1, logoWaitMs: 0 }), a, "kept for the short TTL");
  assert.notEqual(await renderCard({ model: m, images, mint: K.B, now: t0 + CARD_PLACEHOLDER_TTL_MS + 1, logoWaitMs: 0 }), a, "drawn again after it");
  // the top's logo on its way counts the same on a member's card
  resetCards();
  m.setMint({ mint: K.ROOT, decimals: 6, tokenProgram: T22, name: "ROOT coin", symbol: "ROOT", uri: "https://ipfs.io/ipfs/pendingRoot", onchainAt: 1 });
  assert.equal(cardData(m, K.A).bubbles.nodes.find((n) => n.top).imagePending, true);
  assert.equal((await renderCard({ model: m, images: fakeImages({ "https://ipfs.io/ipfs/imgA": logoPng }), mint: K.A, now: t0, logoWaitMs: 0 })).placeholder, true);
  // the metadata lands without an image: nothing more will come, the card keeps for the minute; a failed fetch is the same
  m.setMeta(uri, { image: null, description: null, twitter: null, telegram: null, website: null, fetchedAt: 1, ok: true });
  m.setMeta("https://ipfs.io/ipfs/pendingRoot", { image: null, description: null, twitter: null, telegram: null, website: null, fetchedAt: 1, ok: false, error: "404", attempts: 1 });
  assert.equal(cardData(m, K.B).imagePending, false); assert.equal(cardData(m, K.A).bubbles.nodes.find((n) => n.top).imagePending, false);
  resetCards();
  const b = await renderCard({ model: m, images, mint: K.B, now: t0, logoWaitMs: 0 });
  assert.equal(b.placeholder, false);
  assert.equal(await renderCard({ model: m, images, mint: K.B, now: t0 + CARD_TTL_MS - 1, logoWaitMs: 0 }), b, "the usual TTL");
  // without an image cache nothing can land: never a placeholder
  resetCards();
  m.setMint({ mint: K.B, decimals: 6, tokenProgram: T22, name: "BBB coin", symbol: "BBB", uri: "https://ipfs.io/ipfs/pendingB2", onchainAt: 1 });
  assert.equal(cardData(m, K.B).imagePending, true); assert.equal((await renderCard({ model: m, images: null, mint: K.B, now: t0 })).placeholder, false);
});

test("cardSvg: a shared coin boxed in by its logo children on two rings gets its label outside the family's blob, over no bubble, on a hairline leader", () => {
  const node = (mint, parentMint, depth, extra = {}) => ({ mint, parentMint, depth, symbol: mint, name: null, image: `https://ipfs.io/ipfs/${mint}`, imagePending: false, mcapUsd: 5000, migrated: false, ours: false, asset: false, top: false, focus: false, ...extra });
  const nodes = [node("TOP", null, 0, { image: null, mcapUsd: 1e6, top: true }), node("F", "TOP", 1, { focus: true })];
  for (let i = 0; i < 16; i++) nodes.push(node(`C${i}`, "F", 2));
  const ref = { mint: "TOP", name: null, symbol: "TOP" };
  const data = { mint: "F", name: null, symbol: "F", image: "https://ipfs.io/ipfs/F", imagePending: false, depth: 1, ours: false, migrated: false, complete: false, createdAt: null, mcapUsd: 5000, lockedUsd: null, children: 16, descendants: 16,
    parent: ref, root: ref, chain: [ref, { mint: "F", name: null, symbol: "F" }], lineage: ["$TOP", "$F"], firstborn: true, family: { top: { mint: "TOP", symbol: "TOP" }, under: 17, sharePct: 1 }, bubbles: { nodes, omitted: 0, total: 18, valueUsd: 1e6 + 17 * 5000 } };
  const logos = new Map(nodes.filter((n) => n.image).map((n) => [n.mint, logoPng]));
  const svg = cardSvg(data, { logos });
  // the bubbles' rings and the label's box (text + the "1ST" pill, which stands 8 px above and below), read back from the svg
  const rings = (s) => [...s.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)" fill="none" stroke="#[0-9a-f]{6}" stroke-opacity="0\.(?:8|95)" stroke-width="1\.4"/g)].map((m) => ({ x: +m[1], y: +m[2], r: +m[3] }));
  const labelBox = (s) => {
    const m = s.match(/<text x="([\d.]+)" y="([\d.]+)" font-family="[^"]+" font-weight="500" font-size="(\d+)"[^>]*><tspan fill="#b6ff5c">\$F<\/tspan>/);
    assert.ok(m, "the label");
    const x = +m[1], y = +m[2], size = +m[3], w = measure("$F", { font: "mono", weight: 500, size }) + 12 + PILL_W, h = size * 0.71;
    return { x0: x, y0: y - h - 8, x1: x + w, y1: y + 8, size };
  };
  const circles = rings(svg), box = labelBox(svg);
  assert.equal(circles.length, 18, "every bubble drawn");
  const kids = circles.filter((c) => c.r < 40); // the focus's children all round it: 16 logo discs on two rings
  assert.equal(kids.length, 16); assert.equal((svg.match(/<use /g) ?? []).length, 17, "the shared coin and its 16 children carry logos");
  for (const c of circles) {
    const nx = Math.max(box.x0, Math.min(c.x, box.x1)), ny = Math.max(box.y0, Math.min(c.y, box.y1));
    assert.ok(Math.hypot(c.x - nx, c.y - ny) >= c.r - 1e-6, `the label box (${box.x0.toFixed(0)}..${box.x1.toFixed(0)}, ${box.y0.toFixed(0)}..${box.y1.toFixed(0)}) overlaps the bubble at (${c.x}, ${c.y}) r ${c.r}`);
  }
  assert.ok(box.x0 >= PIC.x0 && box.x1 <= PIC.x1 && box.y0 >= PIC.y0 && box.y1 <= PIC.y1, "inside the picture");
  const leader = svg.match(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)" stroke="#b6ff5c" stroke-opacity="0.6" stroke-width="1"\/>/);
  assert.ok(leader, "the leader line");
  const f = circles.find((c) => c.r >= 40 && Math.abs(c.x - (+leader[1])) < 60);
  assert.ok(f && Math.hypot(+leader[1] - f.x, +leader[2] - f.y) <= f.r + 9, "from just outside the shared coin's ring");
  assert.ok(+leader[3] >= box.x0 - 4 && +leader[3] <= box.x1 + 4 && +leader[4] >= box.y0 - 4 && +leader[4] <= box.y1 + 4, "to the label's near edge");
  // with room beside the ring the label sits there, no leader
  const few = cardSvg({ ...data, bubbles: { ...data.bubbles, nodes: nodes.slice(0, 4), total: 4 } }, { logos });
  assert.ok(!/stroke-opacity="0.6" stroke-width="1"\/>/.test(few), "no leader when a spot beside the ring is free");
  const fb = labelBox(few), ff = rings(few).find((c) => c.r >= 40);
  assert.ok(Math.hypot(ff.x - Math.max(fb.x0, Math.min(ff.x, fb.x1)), ff.y - Math.max(fb.y0, Math.min(ff.y, fb.y1))) <= ff.r + 16 + 2 * 20 + 20, "beside its ring");
});

test("pickBubbles: the shared coin, its chain, its children largest first, then the family largest first, capped, deterministic", () => {
  const fam = synthFamily(300, 40);
  const { nodes, omitted } = pickBubbles(fam, "G39");
  assert.equal(nodes.length, BUBBLE_CAP); assert.equal(omitted, fam.length - BUBBLE_CAP);
  assert.deepEqual(nodes.slice(0, 1).map((n) => [n.mint, n.top]), [["TOP", true]], "the top first");
  const mints = nodes.map((n) => n.mint);
  assert.ok(mints.includes("G39") && mints.includes("K0"), "the focus (the smallest grandchild) and its parent are always in");
  assert.equal(nodes.filter((n) => n.focus).length, 1); assert.equal(nodes.filter((n) => n.top).length, 1);
  const byMint = new Map(nodes.map((n) => [n.mint, n]));
  for (const n of nodes) if (n.parentMint) assert.ok(byMint.has(n.parentMint), `${n.mint} hangs from a drawn parent`);
  // the focus's children come before the rest of the family: K0's 40 grandchildren → the first 20 by market cap
  const k0 = pickBubbles(fam, "K0");
  const gs = k0.nodes.filter((n) => n.parentMint === "K0").map((n) => n.mint);
  assert.equal(gs.length, FOCUS_KIDS); assert.deepEqual(gs, Array.from({ length: FOCUS_KIDS }, (_, i) => `G${i}`), "largest first");
  assert.deepEqual(pickBubbles(fam, "G39"), pickBubbles([...fam].reverse(), "G39"), "the same choice whatever the input order");
  assert.deepEqual(pickBubbles(fam.slice(0, 1), "TOP"), { nodes: [{ ...fam[0], focus: true, top: true }], omitted: 0 }, "a lone coin");
  assert.deepEqual(pickBubbles(fam, "nope"), { nodes: [], omitted: fam.length });
  const small = pickBubbles(synthFamily(5), "K2"); assert.equal(small.nodes.length, 6); assert.equal(small.omitted, 0);
});

test("layoutFamily: deterministic, no overlaps, every bubble inside the picture, the shared coin big enough, tiny bubbles dropped, the svg byte budget kept", () => {
  const asset = synthAssetFamily(200);
  for (const [what, fam, focus] of [["3", synthFamily(2), "K1"], ["20", synthFamily(19), "K7"], ["72 wide", synthFamily(200), "K150"], ["72 deep", synthFamily(60, 40), "G30"], ["lone", synthFamily(0), "TOP"], ["asset depth-2", asset, "E3"], ["asset depth-0 with 12 children", asset, "C0"], ["asset top", asset, "PUMP"]]) {
    const { nodes } = pickBubbles(fam, focus);
    const a = layoutFamily(nodes, focus, { total: fam.length, valueUsd: 1e6 }), b = layoutFamily(nodes, focus, { total: fam.length, valueUsd: 1e6 });
    assert.deepEqual(a, b, `${what}: the same input lays out the same way`);
    assertPacked(a.circles, what);
    assert.ok(a.circles.every((c) => c.r >= R_SMALLEST - 1e-6), `${what}: nothing under ${R_SMALLEST} px`);
    const f = a.circles.find((c) => c.focus); assert.ok(f, `${what}: the focus is drawn`);
    assert.ok(f.r >= R_FOCUS_DRAWN_MIN - 1e-6, `${what}: the focus is drawn at ${f.r.toFixed(1)} px, under ${R_FOCUS_DRAWN_MIN}`);
    assert.ok(f.r >= Math.min(R_FOCUS_MIN, a.circles.find((c) => c.top).r) * a.scale - 1e-6, `${what}: the focus keeps its minimum`);
    assert.ok(a.scale <= 1 && a.scale > 0, "never enlarged");
    for (const c of a.circles) if (c.parentMint === focus) assert.ok(c.r >= R_KID_SMALLEST - 1e-6 || !nodes.filter((n) => n.parentMint === focus).sort((x, y) => (y.mcapUsd ?? -1) - (x.mcapUsd ?? -1)).slice(0, FOCUS_KIDS_KEEP).some((n) => n.mint === c.mint), `${what}: a kept child of the focus is not a ${c.r.toFixed(1)} px speck`);
    if (fam === asset) { assert.ok(a.circles.some((c) => c.mint === "PUMP" && c.top && c.asset), `${what}: the asset top is drawn`); assert.ok(["C0", "D0"].every((m) => focus !== "E3" || a.circles.some((c) => c.mint === m)), "the chain to the asset top stays"); }
  }
  // a shared coin with many floor-sized children: at most its FOCUS_KIDS_KEEP largest are protected, and only while they are not specks
  { const wide = synthFamily(200); for (let i = 0; i < 40; i++) wide.push({ mint: `S${i}`, parentMint: "K150", depth: 2, symbol: `S${i}`, name: null, image: null, mcapUsd: null, migrated: false, ours: false, asset: false });
    const { nodes } = pickBubbles(wide, "K150"), lay = layoutFamily(nodes, "K150", { total: wide.length, valueUsd: 1e6 });
    const f = lay.circles.find((c) => c.focus), kids = lay.circles.filter((c) => c.parentMint === "K150");
    assert.ok(f.r >= R_FOCUS_DRAWN_MIN - 1e-6, `the focus is ${f.r.toFixed(1)} px`); assert.ok(kids.every((c) => c.r >= R_SMALLEST - 1e-6));
    assert.ok(nodes.filter((n) => n.parentMint === "K150").length === FOCUS_KIDS && lay.dropped > 0, "the pick keeps 20 children; the layout lets the speck-sized ones go");
  }
  // a family of 1 500 children: 72 drawn, some dropped only when they would be too small, all within budget
  const big = synthFamily(1500, 30);
  const t0 = performance.now();
  const { nodes, omitted } = pickBubbles(big, "G10");
  const lay = layoutFamily(nodes, "G10", { total: big.length, valueUsd: 5e6 });
  const ms = performance.now() - t0;
  assert.ok(ms < 250, `pick + layout of a 1 500-child family took ${ms.toFixed(0)} ms`);
  assert.equal(nodes.length, BUBBLE_CAP); assert.equal(omitted + lay.dropped + lay.circles.length, big.length);
  assertPacked(lay.circles, "1500");
  // the byte budget never costs a bubble: huge logos on every member → the logos go, the smallest bubbles' first, the shared
  // coin's and the top's kept, every member still drawn where it was
  const bytes = new Map(nodes.map((n) => [n.mint, 40_000]));
  const tight = layoutFamily(nodes, "G10", { total: big.length, valueUsd: 5e6, logoBytes: bytes, maxBytes: 400_000 });
  const keptBytes = (l, b) => l.circles.filter((c) => !l.noLogo.has(c.mint)).reduce((n, c) => n + Math.ceil(b.get(c.mint) / 3) * 4, 0);
  assert.ok(keptBytes(tight, bytes) <= 400_000, `${keptBytes(tight, bytes)} bytes of logos over the budget`);
  assert.equal(tight.dropped, lay.dropped, "no member dropped for bytes (the size rules' drops alone)"); assert.deepEqual(tight.circles, lay.circles, "nothing moved");
  assert.ok(tight.noLogo.size > 0 && !tight.noLogo.has("G10") && !tight.noLogo.has("TOP"), "logos shed, never the shared coin's or the top's");
  const withLogo = tight.circles.filter((c) => !tight.noLogo.has(c.mint) && !c.focus && !c.top), shed = tight.circles.filter((c) => tight.noLogo.has(c.mint));
  assert.ok(withLogo.length > 0 && Math.min(...withLogo.map((c) => c.r)) >= Math.max(...shed.map((c) => c.r)) - 1e-6, "the smallest bubbles lose their logos first");
  // a real big-family card (members near the floor, as a live family's are): 72 picked with 10 KB thumbnails each against the
  // card's budget → all 72 drawn, none dropped, the logos of the smallest shed
  const flat = synthFamily(71).map((n) => ({ ...n, image: `https://ipfs.io/ipfs/${n.mint}`, mcapUsd: n.mint === "TOP" ? 1e6 : 800 }));
  const flat72 = pickBubbles(flat, "K5").nodes, ten = new Map(flat72.map((n) => [n.mint, 10_000])), budget = SVG_MAX_BYTES - 64 * 1024;
  const real = layoutFamily(flat72, "K5", { total: flat.length, valueUsd: 1e6, logoBytes: ten, maxBytes: budget });
  assert.equal(flat72.length, BUBBLE_CAP); assert.equal(real.circles.length, BUBBLE_CAP); assert.equal(real.dropped, 0);
  assert.ok(real.noLogo.size > 0 && real.noLogo.size < 30 && keptBytes(real, ten) <= budget, `${real.noLogo.size} logos shed, ${keptBytes(real, ten)} bytes kept`);
  assert.ok(!real.noLogo.has("K5") && !real.noLogo.has("TOP"));
  assert.deepEqual(real.circles, layoutFamily(flat72, "K5", { total: flat.length, valueUsd: 1e6 }).circles, "the budget moves nothing");
  // one image behind every member (logoIds) is embedded once, so it costs its bytes once: within budget, nothing shed
  const shared = layoutFamily(flat72, "K5", { total: flat.length, valueUsd: 1e6, logoBytes: ten, logoIds: new Map(flat72.map((n) => [n.mint, n.top || n.focus ? n.mint : "same"])), maxBytes: budget });
  assert.equal(shared.noLogo.size, 0); assert.equal(shared.dropped, 0);
  assertPacked(tight.circles, "tight");
  // rimPoints walks a polygon's edges every step px or less, vertices included
  const rim = rimPoints([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }], 16);
  assert.equal(rim.length, 28); assert.ok(rim.every((p) => p.x === 0 || p.x === 100 || p.y === 0 || p.y === 100));
  // pure helpers
  const hull = convexHull([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 5, y: 5 }]);
  assert.equal(hull.length, 4); assert.ok(!hull.some((p) => p.x === 5));
  // smoothHull rounds the corners inward, never past HULL_CUT along an edge, and doubles the points per pass
  const sq = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 }], round = smoothHull(sq);
  assert.equal(round.length, 16); assert.ok(round.every((p) => p.x >= 0 && p.x <= 200 && p.y >= 0 && p.y <= 200), "inside the polygon");
  assert.ok(round.every((p) => Math.min(p.x, 200 - p.x) + Math.min(p.y, 200 - p.y) >= HULL_CUT - 1e-9), "a corner is cut by no more than HULL_CUT along its edges");
  assert.ok(!round.some((p) => (p.x === 0 || p.x === 200) && (p.y === 0 || p.y === 200)), "no corner is left");
  assert.deepEqual(smoothHull(sq.slice(0, 2)), sq.slice(0, 2), "fewer than three points come back as given");
  assert.ok(HULL_PAD_IN + HULL_PAD_OUT - HULL_CUT >= 8 && HULL_PAD_IN + HULL_PAD_OUT + 1 <= 30, "the blob keeps every bubble and stays inside the picture margin");
  const two = synthFamily(1); const r = sizeBubbles(two.map((n, i) => ({ ...n, top: i === 0, focus: i === 1 })));
  assert.ok(r.get("TOP") >= 1.3 * r.get("K0") - 1e-6, "the top outgrows its largest member");
  const pos = packFamily(two.map((n, i) => ({ ...n, top: i === 0 })), r, "K0");
  assert.deepEqual(pos.get("TOP"), { x: 0, y: 0 }); assert.ok(dist(pos.get("TOP"), pos.get("K0")) >= r.get("TOP") + r.get("K0"));
  const fitted = fitCluster(two, pos, r, { x0: 0, y0: 0, x1: 100, y1: 100 });
  assert.ok(fitted.s < 1, "a cluster wider than the area is scaled down");
  assert.equal(fitCluster(two, pos, r, { x0: 0, y0: 0, x1: 5000, y1: 5000 }).s, 1, "never up");
});

test("a 1 500-child family's card: cardData, svg under the budget and a raster on the worker within time", async () => {
  const db = new Db(":memory:");
  const m = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 2500, 1000, 1500], log: quiet });
  m.load(); m.setGlobal({ maxCurveDepth: 2, initialRealTokenReserves: "793100000000000", createV2Enabled: true, whitelistedQuoteMints: [] }); m.setSolUsd(100);
  m.upsertCoin({ mint: K.ROOT, curve: "C_ROOT", depth: 0, quoteMint: null, ...base, virtualQuoteReserves: "100000000000", createdAt: 1000 });
  m.setMint({ mint: K.ROOT, decimals: 6, tokenProgram: T22, name: "Big root", symbol: "BIG", uri: null, onchainAt: 1 });
  const bytes = Buffer.alloc(32);
  for (let i = 0; i < 1500; i++) {
    bytes.writeUInt32BE(i + 1, 0); bytes.writeUInt32BE(7, 28);
    const mint = new PublicKey(bytes).toBase58();
    m.upsertCoin({ mint, curve: `C${i}`, depth: 1, quoteMint: K.ROOT, ...base, virtualQuoteReserves: String(1_000_000_000_000 * (1 + (i % 50))), realQuoteReserves: String(10_000_000_000 * (i % 97)), createdAt: 2000 + i, migrated: i % 9 === 0 });
    m.setMint({ mint, decimals: 6, tokenProgram: T22, name: `Kid ${i}`, symbol: `K${i}`, uri: null, onchainAt: 1 });
  }
  const t0 = performance.now();
  const data = cardData(m, K.ROOT);
  const tData = performance.now() - t0;
  assert.equal(data.bubbles.total, 1501); assert.equal(data.bubbles.nodes.length, BUBBLE_CAP); assert.equal(data.bubbles.omitted, 1501 - BUBBLE_CAP);
  assert.equal(data.family.under, 1500);
  const logos = new Map(data.bubbles.nodes.map((n) => [n.mint, logoPng]));
  const t1 = performance.now();
  const svg = cardSvg(data, { logos, now: 3_000_000 * 1000 });
  const tSvg = performance.now() - t1;
  assert.ok(Buffer.byteLength(svg) <= SVG_MAX_BYTES, `svg is ${Buffer.byteLength(svg)} bytes`);
  assert.ok(svg.includes("more<") && svg.includes("1,500 coins"), "the title tail says how many are not drawn");
  const work = new ImgWork({ log: quiet });
  try {
    const t2 = performance.now();
    const png = await rasterize(svg, work);
    const tRaster = performance.now() - t2;
    assert.deepEqual(pngSize(png), { width: CARD_W, height: CARD_H }); save("family-1500", png);
    assert.ok(tData < 400 && tSvg < 200 && tRaster < 1500, `cardData ${tData.toFixed(0)} ms, svg ${tSvg.toFixed(0)} ms, raster ${tRaster.toFixed(0)} ms`);
  } finally { work.close(); db.close(); }
});
