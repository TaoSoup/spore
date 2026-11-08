#!/usr/bin/env node
// Market-cap audit: the market caps a Spore server serves (/api/coin, /api/map) against pump.fun's own
// numbers and, where an RPC is configured, an independent on-chain read of every price step.
//
//   node scripts/mcap-audit.mjs [--base URL] [--sample N] [--seed S] [--onchain K] [--gate F] [--json out.json] [mint ...]
//
//   --base     the Spore server to audit (default https://sporepad.com)
//   --sample   size of the stratified, seeded sample drawn from <base>/api/map?scope=all (default 50,
//              the named mints included); explicit mints replace the sample
//   --seed     sample seed (default 7)
//   --onchain  at most this many rows get the on-chain read (default 60; 0 = none)
//   --gate     exit 1 when fewer than this share of the rows are within ±5 % (e.g. 0.95)
//   --json     write every row to this file
//
// Reference (the gate): pump.fun's LIVE value, market_cap_quote x the quote's live USD price, walked up
// the chain on pump.fun's own data (frontend-api-v3 coins-v2): SOL from pump.fun's sol-price, USDC = 1, a
// listed asset at usd_market_cap / supply. pump.fun's raw usd_market_cap is printed too, but it is frozen
// at each coin's last trade (a child whose parent moved since shows a stale number), so it is not the gate.
//
// Columns: "served" = the server's mcapUsd / reference; "chain" = the same coin priced from the chain
// (curve virtual reserves, or pool vaults + the pool's signed virtual quote reserves, for the coin and
// every ancestor; the root quote's USD price as the server has it, or pump.fun's when the server has
// none, marked *) / reference. Every miss is listed with one class: supply, decimals, sol-usd,
// migrated-pool, token-quoted-chain, stale-after-trade, wrong-quote-mint, pump.fun-stale (the chain
// agrees with the server), no-reference, not-served.
//
// The RPC URL comes from $RPC_URL or ~/.config/spore/rpc-url and is never printed.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodeCurve, decodePool, decodeTokenAccount } from "../lib/decode.mjs";
import { canonicalPumpPoolPdaWithQuote, normalizeQuoteMint, pk } from "../lib/sdk.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const BASE = String(opt("--base", "https://sporepad.com")).replace(/\/+$/, "");
const SAMPLE = Number(opt("--sample", "50"));
const SEED = Number(opt("--seed", "7"));
const ONCHAIN = Number(opt("--onchain", "60"));
const GATE = (() => { const v = opt("--gate", null); return v == null ? null : Number(v); })();
const JSON_OUT = opt("--json", null);
const MINTS = args.filter((a) => !a.startsWith("--"));
const PF = "https://frontend-api-v3.pump.fun";
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const NAMED = [
  ["pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn", "PUMP (listed asset top)"],
  ["CSocnzcRpgSCr1naKcNTieWZUxb6rABe45j844m7pump", "Kimchi (big migrated SOL root)"],
  ["D42TjMjz5H7toPu5md5KBXreZkCSdZMEfLQwmBhJXvb1", "Pokémon (migrated, quoted in CARDS)"],
  ["D9rASpRWPyMYQGVLQLEN4S4Cy8fYE7fP8au9Gy7Upump", "CHARIZARD (child of Pokémon)"],
];
const TOL = 0.05;

let rpcUrl = process.env.RPC_URL || null;
if (!rpcUrl) { try { rpcUrl = readFileSync(join(homedir(), ".config/spore/rpc-url"), "utf8").trim() || null; } catch { rpcUrl = null; } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url, { tries = 3 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (spore-mcap-audit)", accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
      if (r.status === 404) return null;
      if (r.status === 429 || r.status >= 500) { await sleep(800 * (i + 1)); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch { await sleep(500 * (i + 1)); }
  }
  return null;
}
let rpcCalls = 0;
async function accounts(keys) {
  const out = [];
  for (let i = 0; i < keys.length; i += 100) {
    rpcCalls++;
    const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [keys.slice(i, i + 100), { encoding: "base64", commitment: "confirmed" }] }), signal: AbortSignal.timeout(30_000) });
    const j = await r.json();
    if (j.error) throw new Error(`getMultipleAccounts: ${j.error.message}`);
    out.push(...j.result.value.map((a) => (a ? { ...a, data: Buffer.from(a.data[0], "base64") } : null)));
  }
  return out;
}
async function pool(list, n, fn) { const out = new Array(list.length); let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k], k); } })); return out; }
const normQuote = (m) => (!m || m === "11111111111111111111111111111111" || m === SOL ? null : m);
const off = (a, b) => !(a > 0 && b > 0) || Math.abs(a / b - 1) > TOL;
const supplyOf = (p) => Number(p.total_supply_str ?? p.total_supply) / 10 ** (p.base_decimals ?? 6);

// ---------------------------------------------------------------- sample
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
let mapCache = null;
const loadMap = async () => (mapCache ??= await getJson(`${BASE}/api/map?scope=all&limit=all`));
async function drawSample(n) {
  const map = await loadMap();
  if (!map) throw new Error(`map fetch failed: ${BASE}/api/map`);
  const flat = []; const walk = (node, parent, top) => { flat.push({ ...node.coin, parent, top }); for (const k of node.children) walk(k, node.coin.mint, top ?? node.coin); };
  for (const r of map.roots) walk(r, null, null);
  const rand = rng(SEED);
  const pick = (list, k) => { const a = [...list]; const out = []; while (a.length && out.length < k) out.push(a.splice(Math.floor(rand() * a.length), 1)[0]); return out; };
  const real = flat.filter((x) => !x.asset);
  const solTop = (x) => !x.top || !x.top.asset;
  const underAsset = (sym) => (x) => x.top?.asset && x.top.symbol === sym;
  const big = real.filter((x) => x.mcapUsd != null).sort((a, b) => b.mcapUsd - a.mcapUsd);
  const strata = [
    ["root-sol curve", real.filter((x) => x.depth === 0 && !x.parent && !x.migrated), 5],
    ["root-sol migrated (big)", big.filter((x) => x.depth === 0 && !x.parent).slice(0, 12), 3],
    ["root-sol migrated", real.filter((x) => x.depth === 0 && !x.parent && x.migrated), 4],
    ["d1 curve (SOL family)", real.filter((x) => x.depth === 1 && !x.migrated && solTop(x)), 8],
    ["d1 migrated (SOL family)", real.filter((x) => x.depth === 1 && x.migrated && solTop(x)), 5],
    ["d2", real.filter((x) => x.depth === 2 && solTop(x)), 3],
    ["root under PUMP", real.filter((x) => x.depth === 0 && underAsset("PUMP")(x)), 3],
    ["family under PUMP d1", real.filter((x) => x.depth === 1 && underAsset("PUMP")(x)), 2],
    ["root under USDC", real.filter((x) => x.depth === 0 && underAsset("USDC")(x)), 2],
    ["under CARDS", real.filter(underAsset("CARDS")), 3],
    ["under other asset", real.filter((x) => x.top?.asset && !["PUMP", "USDC", "CARDS"].includes(x.top.symbol)), 3],
    ["spore-launched", real.filter((x) => x.ours), 5],
  ];
  const chosen = new Map(NAMED.map(([m]) => [m, "named"]));
  for (const [label, list, k] of strata) for (const x of pick(list.filter((y) => !chosen.has(y.mint)), k)) chosen.set(x.mint, label);
  for (const x of pick(real.filter((y) => !chosen.has(y.mint)), Math.max(0, n - chosen.size))) chosen.set(x.mint, "random");
  return chosen;
}

// ---------------------------------------------------------------- data
const t0 = Date.now();
const chosen = MINTS.length ? new Map(MINTS.map((m) => [m, "given"])) : await drawSample(SAMPLE);
const mints = [...chosen.keys()];
const solPf = (await getJson(`${PF}/sol-price`))?.solPrice ?? null;
const ourCache = new Map(), pfCache = new Map();
const ourOf = async (m) => { if (!ourCache.has(m)) ourCache.set(m, (await getJson(`${BASE}/api/coin/${m}?children=0&trades=0`))?.coin ?? null); return ourCache.get(m); };
const pfOf = async (m) => { if (!pfCache.has(m)) pfCache.set(m, await getJson(`${PF}/coins-v2/${m}`)); return pfCache.get(m); };
const rows = await pool(mints, 6, async (mint) => { const [ours, pf] = await Promise.all([ourOf(mint), pfOf(mint)]); return { mint, stratum: chosen.get(mint), ours, pf }; });
// A listed asset (PUMP, USDC, CARDS, ...) has no coin page: its bubble on the map is what is served.
if (rows.some((r) => !r.ours)) {
  const map = await loadMap();
  const assets = new Map((map?.roots ?? []).filter((n) => n.coin.asset).map((n) => [n.coin.mint, n.coin]));
  for (const r of rows) if (!r.ours && assets.has(r.mint)) { r.ours = { ...assets.get(r.mint), asset: true }; r.assetNode = true; }
}

// pump.fun live USD price per token, walked up pump.fun's own chain.
const liveMemo = new Map();
async function pfLivePrice(m, depth = 0) {
  if (m === USDC) return 1;
  if (normQuote(m) == null) return solPf;
  if (liveMemo.has(m)) return liveMemo.get(m);
  const p = await pfOf(m);
  let v = null;
  if (p) {
    const sup = supplyOf(p);
    if (p.market_cap_quote != null && sup > 0 && depth < 6 && (p.quote_mint || p.program === "pump") && p.program !== "non_launchpad") {
      const qu = await pfLivePrice(normQuote(p.quote_mint) ?? SOL, depth + 1);
      v = qu != null ? (p.market_cap_quote / sup) * qu : null;
    }
    if (v == null && p.usd_market_cap > 0 && sup > 0) v = p.usd_market_cap / sup; // a listed asset (PUMP, CARDS, stocks)
  }
  liveMemo.set(m, v); return v;
}
const pfPqOf = (p) => (p && p.market_cap_quote != null && supplyOf(p) > 0 ? p.market_cap_quote / supplyOf(p) : null);

for (const r of rows) {
  const o = r.ours, p = r.pf;
  r.pfUsd = p?.usd_market_cap ?? null;
  if (r.assetNode) r.pfLive = r.pfUsd; // an asset is compared with pump.fun's own usd_market_cap
  else if (p) { const lp = await pfLivePrice(r.mint); r.pfLive = lp != null && supplyOf(p) > 0 ? lp * supplyOf(p) : null; }
  else r.pfLive = null;
  r.served = o?.mcapUsd != null && r.pfLive ? o.mcapUsd / r.pfLive : null;
  r.raw = o?.mcapUsd != null && r.pfUsd ? o.mcapUsd / r.pfUsd : null;
  r.chainCoins = [];
  if (o && !r.assetNode) {
    r.chainCoins.push(o);
    for (const a of o.ancestors ?? []) { const ao = await ourOf(a.mint); if (!ao) break; r.chainCoins.push(ao); }
  }
  const venue = o && !r.assetNode ? (o.migrated ? "pool" : "curve") : "";
  const kind = !o ? "?" : r.assetNode ? "asset" : o.ours ? "spore" : o.depth > 0 ? `child d${o.depth}` : o.quoteMint ? `root/${o.quoteSymbol}` : "root/SOL";
  r.kind = `${kind} ${venue}`.trim();
}

// ---------------------------------------------------------------- on-chain (every step of every chain)
const chainPq = new Map(); // mint → quote per token from the chain
if (rpcUrl && ONCHAIN > 0) {
  const want = new Map();
  for (const r of rows.filter((x) => x.chainCoins.length).slice(0, ONCHAIN)) for (const c of r.chainCoins) want.set(c.mint, c);
  const coins = [...want.values()];
  const keyOf = (c) => (c.migrated ? c.pool ?? canonicalPumpPoolPdaWithQuote(pk(c.mint), normalizeQuoteMint(c.quoteMint ? pk(c.quoteMint) : null)).toBase58() : c.curve);
  try {
    const keyed = coins.filter((c) => keyOf(c));
    const infos = await accounts(keyed.map(keyOf));
    const pools = [];
    keyed.forEach((c, i) => {
      const info = infos[i]; if (!info) return;
      const bd = c.decimals ?? 6, qd = c.quoteDecimals ?? 9;
      try {
        if (!c.migrated) {
          const cur = decodeCurve(info.data, c.curve);
          const vt = Number(BigInt(cur.virtualTokenReserves));
          if (vt > 0) chainPq.set(c.mint, (Number(BigInt(cur.virtualQuoteReserves)) / 10 ** qd) / (vt / 10 ** bd));
        } else {
          const p = decodePool(info.data);
          if (p) pools.push({ c, p, bd, qd });
        }
      } catch { /* not decodable: no chain step */ }
    });
    const vaults = await accounts(pools.flatMap(({ p }) => [p.baseVault, p.quoteVault]));
    pools.forEach(({ c, p, bd, qd }, i) => {
      const b = vaults[2 * i] ? decodeTokenAccount(vaults[2 * i].data) : null, q = vaults[2 * i + 1] ? decodeTokenAccount(vaults[2 * i + 1].data) : null;
      if (!b || !q || BigInt(b.amount) <= 0n) return;
      const eff = BigInt(q.amount) + BigInt(p.virtualQuoteReserves);
      if (eff <= 0n) return;
      chainPq.set(c.mint, (Number(eff) / 10 ** qd) / (Number(BigInt(b.amount)) / 10 ** bd));
    });
  } catch (e) { console.error(`on-chain read skipped: ${e.message}`); }
}
for (const r of rows) {
  const ch = r.chainCoins;
  if (!ch.length || !r.pfLive || !ch.every((c) => chainPq.has(c.mint))) { r.chain = null; continue; }
  const root = ch[ch.length - 1];
  const prodChain = ch.reduce((a, c) => a * chainPq.get(c.mint), 1);
  const prodOurs = ch.reduce((a, c) => a * (c.priceQuote ?? NaN), 1);
  let quoteUsd = r.ours.priceUsd > 0 && prodOurs > 0 ? r.ours.priceUsd / prodOurs : null, fromPf = false;
  if (quoteUsd == null) { quoteUsd = await pfLivePrice(root.quoteMint ?? SOL); fromPf = true; }
  const supply = Number(BigInt(r.ours.totalSupply ?? 0)) / 10 ** (r.ours.decimals ?? 6);
  r.chain = quoteUsd != null && supply > 0 ? (prodChain * quoteUsd * supply) / r.pfLive : null;
  r.chainFromPf = fromPf;
}

// ---------------------------------------------------------------- classify a miss
async function stepClass(c) {
  const p = await pfOf(c.mint);
  const ours = c.priceQuote, pf = pfPqOf(p), chain = chainPq.get(c.mint) ?? null;
  const bad = c.migrated ? "migrated-pool" : "stale-after-trade";
  if (chain != null) {
    if (off(ours, chain)) return bad; // the server's step disagrees with the chain
    return pf != null && off(pf, chain) ? "pump.fun-stale" : null; // the chain agrees with the server
  }
  if (pf == null) return null; // nothing to compare this step with
  return off(ours, pf) ? bad : null;
}
async function classOf(r) {
  const o = r.ours, p = r.pf;
  if (!o) return "not-served";
  if (!r.pfLive) return "no-reference";
  if (r.assetNode) return o.mcapUsd == null ? "token-quoted-chain" : "supply";
  if ((p.base_decimals != null && o.decimals !== p.base_decimals) || (p.quote_decimals != null && o.quoteDecimals !== p.quote_decimals)) return "decimals";
  if (normQuote(o.quoteMint) !== normQuote(p.quote_mint)) return "wrong-quote-mint";
  if (o.totalSupply != null && String(o.totalSupply) !== String(p.total_supply_str ?? p.total_supply)) return "supply";
  if (o.mcapUsd == null && o.priceQuote != null && o.priceSol == null) return "token-quoted-chain";
  for (let i = 0; i < r.chainCoins.length; i++) {
    const c = r.chainCoins[i];
    const cls = await stepClass(c);
    if (cls) return i === 0 ? cls : `${cls} (via ${c.symbol ?? c.mint.slice(0, 6)})`;
  }
  const root = r.chainCoins[r.chainCoins.length - 1] ?? o;
  if (normQuote(root.quoteMint) == null) {
    const solOurs = o.priceSol > 0 ? o.priceUsd / o.priceSol : null;
    return off(solOurs, solPf) ? "sol-usd" : "other";
  }
  return root.quoteMint === USDC ? "other" : "token-quoted-chain";
}
for (const r of rows) {
  const miss = r.served == null || Math.abs(r.served - 1) > TOL;
  r.cls = miss ? await classOf(r) : "";
  const chainMiss = r.chain == null || Math.abs(r.chain - 1) > TOL;
  r.chainOk = !chainMiss;
}

// ---------------------------------------------------------------- report
const fmt = (v, d = 3) => (v == null || !Number.isFinite(v) ? "-" : Math.abs(v) >= 1e4 ? Math.round(v).toLocaleString("en-US") : v.toPrecision(d));
const ratio = (x) => (x == null ? "-" : x.toFixed(3));
const head = ["mint", "symbol", "kind", "stratum", "served mcapUsd", "pf usd_mcap (raw)", "reference (pf live)", "served", "chain", "class"];
const table = rows.map((r) => [
  r.mint.slice(0, 6) + "…" + r.mint.slice(-4), (r.ours?.symbol ?? r.pf?.symbol ?? "?").slice(0, 12), r.kind, r.stratum,
  fmt(r.ours?.mcapUsd), fmt(r.pfUsd), fmt(r.pfLive), ratio(r.served), r.chain == null ? "-" : ratio(r.chain) + (r.chainFromPf ? "*" : ""), r.cls || "ok",
]);
const widths = head.map((h, i) => Math.min(i === head.length - 1 ? 60 : 24, Math.max(h.length, ...table.map((row) => String(row[i]).length))));
const line = (row) => row.map((c, i) => String(c).slice(0, widths[i]).padEnd(widths[i])).join(" | ");
console.log(`base ${BASE}  sample ${rows.length} (seed ${SEED})  reference: pump.fun live (coins-v2)  tolerance ±${TOL * 100}%`);
// A cold server has not re-read its pools yet: show how long it has run and when its vaults were last read.
const health = await getJson(`${BASE}/api/health`, { tries: 1 }).catch(() => null);
const ago = (t) => (t ? `${Math.max(0, Math.round(Date.now() / 1000 - t))} s ago` : "never/unknown");
console.log(`server uptime ${health?.uptimeS != null ? `${health.uptimeS} s` : "unknown"}  last refresh ${ago(health?.indexer?.lastRefreshAt)}  last vault read ${ago(health?.indexer?.lastVaultsAt)}  pricing pools re-read ${ago(health?.indexer?.pricingPoolsAt)}`);
console.log(line(head)); console.log(widths.map((w) => "-".repeat(w)).join("-|-"));
for (const row of table) console.log(line(row));
const n = rows.length;
const k = rows.filter((r) => r.served != null && Math.abs(r.served - 1) <= TOL).length;
const kc = rows.filter((r) => r.chainOk).length;
const kr = rows.filter((r) => r.raw != null && Math.abs(r.raw - 1) <= TOL).length;
const pct = (a) => ((100 * a) / Math.max(1, n)).toFixed(1);
console.log("");
console.log(`within5 ${k}/${n} (${pct(k)}%)   [served vs the pump.fun live reference]`);
console.log(`chain   ${kc}/${n} (${pct(kc)}%)   [projection: every price step read on chain${rpcUrl && ONCHAIN > 0 ? "" : " — NO RPC configured, not computed"}]`);
console.log(`raw     ${kr}/${n} (${pct(kr)}%)   [served vs pump.fun's raw usd_market_cap, frozen at each coin's last trade; not the gate]`);
console.log(`SOL/USD: served ${fmt(rows.map((r) => (r.ours?.priceSol > 0 ? r.ours.priceUsd / r.ours.priceSol : null)).find((x) => x), 6)}  pump.fun ${fmt(solPf, 6)}  on-chain reads: ${chainPq.size} coins, ${rpcCalls} RPC calls  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
const misses = rows.filter((r) => r.cls);
const stale = misses.filter((r) => r.cls.startsWith("pump.fun-stale")).length;
console.log(`        ${k + stale}/${n} (${pct(k + stale)}%)   [within5 plus the misses where the chain agrees with the server (pump.fun-stale); information, not the gate]`);
const classes = {};
for (const r of misses) { const c = r.cls.replace(/ \(via .*\)$/, ""); classes[c] = (classes[c] ?? 0) + 1; }
console.log(`misses ${misses.length}: ${Object.entries(classes).map(([c, x]) => `${c} ${x}`).join(", ") || "none"}`);
const ageOf = (r) => (r.pf?.last_trade_timestamp ? `${((Date.now() - r.pf.last_trade_timestamp) / 3600e3).toFixed(1)}h` : "-");
for (const r of misses) console.log(`  ${r.mint}  ${(r.ours?.symbol ?? r.pf?.symbol ?? "?").padEnd(12)} served ${ratio(r.served).padEnd(6)} chain ${(r.chain == null ? "-" : ratio(r.chain)).padEnd(6)} pf last trade ${ageOf(r).padStart(7)} ago  ${r.cls}`);
if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({ base: BASE, seed: SEED, at: new Date().toISOString(), within5: { k, n }, chain: { k: kc, n }, raw: { k: kr, n }, solPf, rpcCalls,
    rows: rows.map((r) => ({ mint: r.mint, symbol: r.ours?.symbol ?? r.pf?.symbol ?? null, kind: r.kind, stratum: r.stratum, mcapUsd: r.ours?.mcapUsd ?? null, priceUsd: r.ours?.priceUsd ?? null, priceQuote: r.ours?.priceQuote ?? null, migrated: r.ours?.migrated ?? null,
      pfUsd: r.pfUsd, pfLive: r.pfLive, pfLastTrade: r.pf?.last_trade_timestamp ?? null, served: r.served, chain: r.chain, chainFromPf: !!r.chainFromPf, raw: r.raw, class: r.cls || null, chainPq: chainPq.get(r.mint) ?? null })) }, null, 1));
}
if (GATE != null && Number.isFinite(GATE) && k / Math.max(1, n) < GATE) { console.log(`GATE FAIL: ${k}/${n} < ${GATE}`); process.exitCode = 1; }
else if (GATE != null) console.log(`GATE PASS: ${k}/${n} >= ${GATE}`);
