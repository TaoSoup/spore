// make-swarm-fixture (DESIGN-FAMILY-ALL.md §5.5): a prod-like /api/map fixture for the swarm gates. The real payload, with
// every listed-asset top's `children` raised to the production counts measured on chain (2026-10-24): PUMP 76,470, USDC
// 41,450, SPCX 17,031, SPYx 16,434, WBTC 6,621, NVDAx 6,598, ZEC 6,175, DJT 5,957, CARDS 4,680, TTWO 4,618; then the other
// asset tops' counts scaled by one common factor until the undrawn coins (Σ ghost = Σ children − drawn kids) reach the
// target (default 300,000). Nothing is drawn differently: the drawn slice, its layout and every family value stay the
// payload's; only the asset tops' true sizes grow (`descendants` and `indexed` follow). heat.json is copied beside it.
//
//   node --import tsx test/make-swarm-fixture.mts --from <map.json> --out <dir> [--heat <heat.json>] [--target 300000]
//     [--api http://127.0.0.1:8795]   (no --heat and no heat.json beside --from: GET <api>/api/map/heat)
//   then: node --import tsx test/serve-prod.mts --dist <dist> --port <p> --fixture <dir>
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const argv = process.argv.slice(2);
const opt = (name: string, dflt: string | null = null) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt; };
const FROM = opt("--from"), OUT = opt("--out");
if (!FROM || !OUT) { console.error("usage: make-swarm-fixture --from <map.json> --out <dir> [--heat <heat.json>] [--target 300000]"); process.exit(2); }
const TARGET = Number(opt("--target", "300000"));
const API = (opt("--api", "http://127.0.0.1:8795") ?? "").replace(/\/$/, "");

/// production counts by asset ticker (pump's quote control, full walk 2026-10-24)
export const PROD_CHILDREN: Record<string, number> = { PUMP: 76470, USDC: 41450, SPCX: 17031, SPYx: 16434, WBTC: 6621, NVDAx: 6598, ZEC: 6175, DJT: 5957, CARDS: 4680, TTWO: 4618 };

type Coin = { mint: string; symbol?: string | null; asset?: boolean; children?: number; descendants?: number; [k: string]: unknown };
type Tree = { coin: Coin; children?: Tree[] };
type MapBody = { roots: Tree[]; total?: number; indexed?: number; [k: string]: unknown };

const body = JSON.parse(readFileSync(resolve(FROM), "utf8")) as MapBody;
if (!Array.isArray(body.roots)) throw new Error(`${FROM}: no roots[] (a /api/map?scope=all&limit=all body is expected)`);
const tops = body.roots.filter((r) => r && r.coin && r.coin.asset === true).map((r) => ({ r, drawn: Array.isArray(r.children) ? r.children.length : 0, c0: Math.max(0, Number(r.coin.children) || 0) }));
const ghostOf = (children: number, drawn: number) => Math.max(0, children - drawn);
const named = new Map<string, number>();
for (const t of tops) { const s = String(t.r.coin.symbol ?? ""); if (PROD_CHILDREN[s] !== undefined && !named.has(s)) named.set(s, PROD_CHILDREN[s]); }
const isNamed = (t: (typeof tops)[number]) => PROD_CHILDREN[String(t.r.coin.symbol ?? "")] !== undefined;
const fixed = tops.filter(isNamed).reduce((s, t) => s + ghostOf(Math.max(t.c0, PROD_CHILDREN[String(t.r.coin.symbol)]), t.drawn), 0);
const rest = tops.filter((t) => !isNamed(t));
const restGhost = (f: number) => rest.reduce((s, t) => s + ghostOf(Math.round(t.c0 * f), t.drawn), 0);
let factor = 1;
if (fixed + restGhost(1) < TARGET && rest.length) {
  let lo = 1, hi = 2;
  while (fixed + restGhost(hi) < TARGET && hi < 1e6) hi *= 2;
  for (let q = 0; q < 60; q++) { const mid = (lo + hi) / 2; if (fixed + restGhost(mid) >= TARGET) hi = mid; else lo = mid; }
  factor = hi;
}
let ghost = 0;
const report: [string, number, number, number][] = [];
for (const t of tops) {
  const s = String(t.r.coin.symbol ?? "");
  const c1 = isNamed(t) ? Math.max(t.c0, PROD_CHILDREN[s]) : Math.round(t.c0 * factor);
  const add = c1 - t.c0;
  t.r.coin.children = c1;
  if (Number.isFinite(t.r.coin.descendants)) t.r.coin.descendants = (t.r.coin.descendants as number) + add;
  ghost += ghostOf(c1, t.drawn);
  report.push([s, t.c0, c1, ghostOf(c1, t.drawn)]);
}
const drawnTotal = (() => { let n = 0; const st: Tree[] = [...body.roots]; while (st.length) { const t = st.pop()!; n++; for (const k of t.children ?? []) st.push(k); } return n; })();
body.indexed = drawnTotal + ghost;

mkdirSync(resolve(OUT), { recursive: true });
writeFileSync(join(resolve(OUT), "map.json"), JSON.stringify(body));
const heatSrc = opt("--heat") ?? join(dirname(resolve(FROM)), "heat.json");
if (existsSync(heatSrc)) copyFileSync(heatSrc, join(resolve(OUT), "heat.json"));
else {
  const r = await fetch(`${API}/api/map/heat`, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`heat: ${r.status} from ${API}/api/map/heat (pass --heat)`);
  writeFileSync(join(resolve(OUT), "heat.json"), Buffer.from(await r.arrayBuffer()));
}
report.sort((a, b) => b[3] - a[3]);
console.log(JSON.stringify({ out: resolve(OUT), assetTops: tops.length, named: [...named.keys()], factor: +factor.toFixed(3), ghost, drawn: drawnTotal, indexed: body.indexed,
  top: report.slice(0, 14).map(([s, a, b, g]) => `${s} ${a}->${b} ghost ${g}`) }, null, 1));
