// Development fixture for the root agents (DESIGN §13.1), shaped exactly like GET /api/agents,
// GET /api/agents/:root and GET /api/agents/coin/:mint. data.ts imports it only behind
// `import.meta.env.DEV` and only while the server answers those routes with 404, so it never
// reaches a production bundle. The two roots, their agent wallets and the coins the agents
// launched are the real ones on sporepad.com (2026-10-19); the ledger lines are made up in the
// shapes the live modules write, so every kind and status of the activity timeline can be laid out.
import { solscanTx, type ActivityItem, type Agent, type AgentCoin, type AgentDetail, type AgentLaunched, type AgentProposal, type AgentTotals, type CoinRef } from "../../lib/api";

const img = (u: string) => `/api/img?u=${encodeURIComponent(u)}`;
const meta = (hash: string, ext = "png") => img(`https://spore-2x6.pages.dev/m/${hash}.${ext}`);
const MODEL = "anthropic/claude-sonnet-5.5";
const OWNER = "7fSCMhvjPj224aMjYX2AGdjCS7TnPJaZSdMgsb4D7pox";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
let seed = 11;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const sig = () => Array.from({ length: 88 }, () => B58[Math.floor(rnd() * 58)]).join("");

type Kid = { mint: string; name: string; symbol: string; hash: string; createdAt: number; why: string | null; logoSource: string; description: string; runnersUp: [string, string][] };
type Root = { ref: CoinRef; address: string; sol: number; usdc: number; usd: number; profile: Agent["profile"]; score: number; scoreReason: string; runs: number; kids: Kid[]; seedAt: number; payouts: { at: number; sol: number; usdc: number; status: string }[] };

const ROOTS: Root[] = [
  {
    ref: { mint: "HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY", name: "Spore", symbol: "SPORE", depth: 0, image: meta("dfafb1ba6262c6d6f01a31dcce4dd3b46ddabc19daf008110006ef30defeb474") },
    address: "3zCddmWsJ7GMM91urmMdM1x5D7tHpfLp4z4xN4rpc3V2", sol: 0.013336971, usdc: 1.010049, usd: 2.41, runs: 10, score: 48,
    scoreReason: "momentum 48/100: 17 children, 2 trades/1h (100% buys), 2000 trades and $85.6K volume in 24 h, last proposal 55 min ago",
    profile: { summary: "$SPORE (Spore): a pump.fun launchpad for connected coin trees. Its children riff on spores, launchpads and roots that connect.", themes: ["spore", "launchpad", "connected", "trees", "root", "connect"], tone: "organic, curious, grow-together", avoid: ["real people's names", "brand names and trademarks", "slurs or hateful language", "price promises"], palette: ["#b6ff5c", "#0b3a22", "#06120a"], source: "model", builtAt: 1792445000 },
    seedAt: 1792444716,
    kids: [
      { mint: "6SroafzVJgbqwbhT93x2gsqTfWqXfz5ig7QZ1YMmBJom", name: "Treesling", symbol: "TREESLING", hash: "41ff11681e1bef601f44b2a7ab7f3c4837b57ba48c87a6a741aefa9f6e47e023", createdAt: 1792448066, why: null, logoSource: "template", description: "A wild offshoot of the $SPORE tree. Trees energy, root vibes, nothing serious.", runnersUp: [["Spore Kin", "SPORKIN"], ["Lil Root", "LILROOT"]] },
      { mint: "691kMq8MFLPcmcPkmzehfss1vhRwUmCYuXVxohuTNU4m", name: "Rootkin", symbol: "ROOTKIN", hash: "810d3708192b866e1934866df8cf195dd3d151370710c397cc04b074caaef13f", createdAt: 1792447714, why: "Every tree needs kin; this one glows.", logoSource: "image", description: "A glowing offshoot of the $SPORE tree. Root energy, launchpad vibes, nothing serious.", runnersUp: [["Spore Print", "PRINT"], ["Hyphae", "HYPHA"]] },
      { mint: "2ihGzF4qaa9aDu56w2kreoKQ5aDx9nnDSJjE5P6zVLoa", name: "Wore Root", symbol: "WOREROOT", hash: "f4e3bae8148411182c87792c9a89c05e453d49452a0a6dc81fac3d27c5294951", createdAt: 1792447114, why: "Roots that have seen things, launched where the wild branches go.", logoSource: "model", description: "Connect and launchpad, the wild way. A new branch under $SPORE.", runnersUp: [["Germinate", "GERM"]] },
      { mint: "8zgWAUtBLHqvdtsuwqGWGWE8y2toyxEFLeH8hpK6kQUR", name: "Root Puff", symbol: "ROOTPUFF", hash: "e6eea63280775de0ec790868a8b30a20486ff4aee9758b31173f1ebb74956995", createdAt: 1792446813, why: "Tiny puffs grow the biggest roots.", logoSource: "image", description: "Launchpad and connect, the tiny way. A new branch under $SPORE.", runnersUp: [["Spore Cloud", "CLOUD"], ["Fruiting Body", "FRUIT"]] },
      { mint: "3jCxhydpkxUEuTwUNU1j1bpSNai9qaBP1mpSCG69Ctrp", name: "Connect Puff", symbol: "CPUFF", hash: "272cd63da01ecdfa49efe962160d48fdf8db37ef68a2cc56dcf809b7f2397e19", createdAt: 1792446516, why: "Launchpads glow brighter when every branch is connected.", logoSource: "image", description: "Launchpad and trees, the glowing way. A new branch under $SPORE.", runnersUp: [["Mycelium Net", "MYCNET"], ["Hyphae", "HYPHA"], ["Spore Print", "PRINT"]] },
    ],
    payouts: [{ at: 1792448370, sol: 0.0315, usdc: 1.010049, status: "landed" }, { at: 1792447418, sol: 0.12, usdc: 0, status: "landed" }, { at: 1792448726, sol: 0.012, usdc: 0, status: "expired" }],
  },
  {
    ref: { mint: "FTcrJuck7yqAgQQzv9uud7MH2Av8S3mP9iveiXsutNeX", name: "spread AGENT", symbol: "SPREAD", depth: 0, image: meta("cba014b4c2967933f941e2d41a4a987cea27f9e293d8211c685df2e6c261d0f4", "jpg") },
    address: "3QZcZTf5qrBvc7LidERn283Nj69rTE1H47VfgMaahcQW", sol: 0.028464138, usdc: 0, usd: 2.99, runs: 5, score: 72,
    scoreReason: "momentum 72/100: 3 children, 198 trades/1h (59% buys), 198 trades and $15.2K volume in 24 h, last proposal 7 min ago",
    profile: { summary: "Little is documented about spread AGENT ($SPREAD): no description, socials or website. The name suggests an AI-agent theme built around the idea of spreading, so the identity is still open to be shaped.", themes: ["spread", "agent", "community"], tone: "deadpan, clever, slightly mischievous, deliberately cryptic", avoid: ["real people's names", "brand names and trademarks", "slurs or hateful language", "price promises or financial advice", "clones of $SPREAD"], palette: ["#c38cff", "#492c7a", "#0f0a1a"], source: "fallback", builtAt: 1792450736 },
    seedAt: 1792450300,
    kids: [
      { mint: "4jB8EFWaLyJDqxXawTuaDeU1swFbuDeXfjuhTTMgq825", name: "Spreadsheet Messiah", symbol: "CELLS", hash: "bab977254d8dc2b425c35a60bd7d80c833b600688144c0229b5e52a63902b275", createdAt: 1792451528, why: "Finally an agent that spreads using only formulas and vibes.", logoSource: "image", description: "Rows. Columns. Prophecy. The messiah has formulas for how every idea propagates and refuses to share the file. Merge cells, merge minds.", runnersUp: [["Butter Knife Agent", "BUTTER"], ["Viral Load Balancer", "VLOAD"], ["Chain Letter Intern", "CHAINI"]] },
      { mint: "6tPoRSApWwQqcL5Foxz54iBC7mCGQkuG9TuXnaGtKjf9", name: "Cc All Agent", symbol: "CCALL", hash: "ea934095cd7851672def0ac0778d98d1a610fa55f1568e09d05505e89a1e549d", createdAt: 1792451345, why: "The most dangerous button in any office finally got its own agent.", logoSource: "image", description: "One tiny click and the entire department is in the loop. A diligent assistant who believes every message deserves maximum distribution. Reply-all is a lifestyle.", runnersUp: [["Double Agent Butter", "BUTTER"], ["Dead Drop Duck", "DEADDUCK"], ["Case Closed Pigeon", "COOCASE"]] },
      { mint: "6qVuDxvu3dtDJwcS1cg5Qb98mgBgCfYhsiT5rkPGwxzS", name: "Rumor Mill Agent", symbol: "RUMORMILL", hash: "74cea1855e0b81891327e5c28156446d4c038bc73f6773164a85d3bd647f6b72", createdAt: 1792451137, why: "Agents move faster than facts, and this one never waits for confirmation.", logoSource: "image", description: "It heard something from an agent who heard it from an agent. Nobody checked. It's already true by the time you finish reading this.", runnersUp: [["Sleeper Cell Agent", "SLEEPER"], ["Chain Letter Agent", "CHAINLTR"], ["Wet Toast Protocol", "WETTOAST"]] },
    ],
    payouts: [],
  },
];

const launched = (k: Kid): AgentLaunched => ({ mint: k.mint, name: k.name, symbol: k.symbol, image: meta(k.hash), createdAt: k.createdAt, signature: sig(), why: k.why, logoSource: k.logoSource });

function proposal(r: Root, k: Kid, rejected = false): AgentProposal {
  return {
    id: k.mint.slice(0, 16).toLowerCase(), createdAt: k.createdAt - 60, name: k.name, symbol: k.symbol, description: k.description,
    image: meta(k.hash), score: r.score, reason: r.scoreReason, source: k.logoSource === "template" ? "fallback" : "model", why: k.why, logoSource: k.logoSource,
    sim: rejected ? { ok: false, bytes: null, unitsConsumed: null, estCostSol: null, err: "simulation unavailable: transaction too large: 1780 bytes (max 1232)" } : { ok: true, bytes: 884, unitsConsumed: 160_657, estCostSol: 0.01478716, err: null },
    runnersUp: k.runnersUp.map(([name, symbol]) => ({ name, symbol })), status: rejected ? "rejected" : "proposed", rejectedReason: rejected ? "simulation failed" : null,
  };
}

/// The ledger of one agent, newest first: the seed claim, then per launch its model calls, the
/// launch itself (two steps), a claim of the root and of the previous child; swaps and payouts.
function activityOf(r: Root): ActivityItem[] {
  const out: ActivityItem[] = [];
  const push = (a: Omit<ActivityItem, "explorer" | "signature"> & { signature?: string | null }) => { const s = a.signature === undefined ? sig() : a.signature; out.push({ ...a, signature: s, explorer: s ? solscanTx(s) : null }); };
  push({ at: r.seedAt, kind: "claim", status: "landed", title: `Claimed 0.0129 SOL from $${r.ref.symbol}`, amountSol: 0.012901, amountUsdc: null, usd: 2.33, mint: r.ref.mint, symbol: r.ref.symbol, signature: null });
  const kids = [...r.kids].reverse();
  kids.forEach((k, i) => {
    const t = k.createdAt - 60;
    push({ at: t - 40, kind: "ai", status: "done", title: `Thought with Claude Sonnet 5.5 ($${(0.0119 + i * 0.0004).toFixed(3)})`, amountSol: null, amountUsdc: null, usd: 0.0119 + i * 0.0004, mint: null, symbol: null, signature: null });
    if (k.logoSource === "image") push({ at: t - 30, kind: "ai", status: "done", title: "Drew a logo ($0.008)", amountSol: null, amountUsdc: null, usd: 0.008, mint: null, symbol: null, signature: null });
    if (i === 2) push({ at: t - 25, kind: "ai", status: "failed", title: "Thought with Claude Sonnet 5.5", amountSol: null, amountUsdc: null, usd: null, mint: null, symbol: null, signature: null });
    push({ at: k.createdAt, kind: "launch", status: "landed", title: `Launched $${k.symbol}`, amountSol: 0.0148, amountUsdc: null, usd: 2.67, mint: k.mint, symbol: k.symbol });
    if (i === 3) {
      push({ at: k.createdAt + 4, kind: "launch", status: "expired", title: `Launched $${k.symbol} · fee split`, amountSol: null, amountUsdc: null, usd: null, mint: k.mint, symbol: k.symbol, signature: null });
      push({ at: k.createdAt + 74, kind: "split", status: "landed", title: `Finished the fee split of $${k.symbol}`, amountSol: 0.0021, amountUsdc: null, usd: null, mint: k.mint, symbol: k.symbol });
    }
    push({ at: k.createdAt + 124, kind: "claim", status: "landed", title: `Claimed ${(0.00842 + i * 0.001894).toFixed(4)} SOL from $${r.ref.symbol}`, amountSol: 0.00842 + i * 0.001894, amountUsdc: null, usd: (0.00842 + i * 0.001894) * 180.7, mint: r.ref.mint, symbol: r.ref.symbol });
    if (i >= 1) push({ at: k.createdAt + 184, kind: "claim", status: "landed", title: `Claimed 1.19 ${r.ref.symbol} from $${kids[i - 1].symbol}`, amountSol: null, amountUsdc: null, usd: 0.21, mint: kids[i - 1].mint, symbol: kids[i - 1].symbol });
  });
  if (r.usdc > 0) {
    push({ at: kids[1].createdAt + 244, kind: "swap", status: "landed", title: "Swapped 0.0073 SOL → 1.01 USDC", amountSol: 0.0073, amountUsdc: 1.010049, usd: 1.01, mint: null, symbol: null });
    // The live ledger also writes a swap whose amounts it never read back, and an x402 refusal whose title carries the facilitator's JSON.
    push({ at: kids[1].createdAt + 250, kind: "swap", status: "landed", title: "Swapped ? SOL for some USDC", amountSol: null, amountUsdc: null, usd: null, mint: null, symbol: null });
    push({ at: kids[2].createdAt - 95, kind: "ai", status: "refused", title: 'Skipped thinking: USDC: Facilitator error: 402 {"correlationId":"a4d319e5a86230f6-IAD","errorLink":"https://example.invalid/errors#payment-method-required"', amountSol: null, amountUsdc: 0.027969, usd: 0.027969, mint: null, symbol: null, signature: null });
  } else {
    push({ at: kids[1].createdAt + 600, kind: "aifee", status: "landed", title: "Paid its AI fee: $0.242 as 0.0023 SOL to the owner", amountSol: 0.002303792, amountUsdc: null, usd: 0.241806, mint: null, symbol: null });
  }
  for (const p of r.payouts) push({ at: p.at, kind: "payout", status: p.status, title: `Paid ${p.sol} SOL${p.usdc ? ` + ${p.usdc.toFixed(2)} USDC` : ""} to the owner`, amountSol: p.sol, amountUsdc: p.usdc || null, usd: p.sol * 180.7 + p.usdc, mint: null, symbol: null });
  push({ at: kids[kids.length - 1].createdAt + 900, kind: "ai", status: "refused", title: "Thought with Claude Sonnet 5.5", amountSol: null, amountUsdc: null, usd: null, mint: null, symbol: null, signature: null });
  const pending = sig();
  out.push({ at: kids[kids.length - 1].createdAt + 1300, kind: "claim", status: "pending", title: `Claimed 0.0042 SOL from $${r.ref.symbol}`, amountSol: 0.0042, amountUsdc: null, usd: 0.76, mint: r.ref.mint, symbol: r.ref.symbol, signature: pending, explorer: solscanTx(pending) });
  return out.sort((a, b) => b.at - a.at);
}

function totalsOf(r: Root, activity: ActivityItem[]): AgentTotals {
  const sum = (kind: ActivityItem["kind"], f: (a: ActivityItem) => number | null, ok = (s: string) => s === "landed" || s === "done") => activity.filter((a) => a.kind === kind && ok(a.status)).reduce((n, a) => n + (f(a) ?? 0), 0);
  return {
    launches: r.kids.length, launchSol: sum("launch", (a) => a.amountSol), claimsSol: sum("claim", (a) => a.amountSol), claimsUsd: sum("claim", (a) => a.usd),
    aiUsd: sum("ai", (a) => a.usd), aiCalls: activity.filter((a) => a.kind === "ai").length, payoutsSol: sum("payout", (a) => a.amountSol), payoutsUsdc: sum("payout", (a) => a.amountUsdc),
    lastActivityAt: activity[0]?.at ?? null,
  };
}

function agent(r: Root): Agent {
  const activity = activityOf(r);
  const kids = r.kids.map(launched);
  return {
    root: r.ref, status: "dry", profile: r.profile, model: MODEL, sleeping: false, reason: "running",
    stats: { runs: r.runs, proposals: r.kids.length + 1, lastRunAt: r.kids[0].createdAt - 60, nextRunAt: r.kids[0].createdAt + 120, score: r.score, scoreReason: r.scoreReason },
    latest: proposal(r, r.kids[0]),
    wallet: { address: r.address, sol: r.sol, usdc: r.usdc, usd: r.usd, updatedAt: Math.floor(Date.now() / 1000) - 25 },
    totals: totalsOf(r, activity), launched: kids.slice(0, 12), activity: activity.slice(0, 8),
  };
}

export const agents = (): Agent[] => ROOTS.map(agent);
export function detail(root: string): AgentDetail | null {
  const r = ROOTS.find((x) => x.ref.mint === root);
  if (!r) return null;
  const a = agent(r);
  const rejected: AgentProposal = { ...proposal(r, { ...r.kids[r.kids.length - 1], mint: "0cbe4768faa937ba0cbe4768faa937ba", name: "Patient Zero Agent", symbol: "PZERO", why: "Every spread has an origin story and this coin claims the title nobody can verify.", createdAt: r.seedAt + 400 }, true), image: null };
  return { agent: a, proposals: [...r.kids.map((k) => proposal(r, k)), rejected], activity: activityOf(r), launched: r.kids.map(launched) };
}
/// `GET /api/agents/coin/:mint` for the fixture roots and the coins their agents launched.
export function coin(mint: string): AgentCoin | null {
  for (const r of ROOTS) {
    const a = agent(r);
    const me = { address: r.address, status: a.status, wallet: a.wallet, totals: a.totals, model: MODEL };
    if (r.ref.mint === mint) return { role: "root", root: r.ref, agent: me, launch: null };
    const k = r.kids.find((x) => x.mint === mint);
    if (k) return { role: "child", root: r.ref, agent: me, launch: { signature: sig(), at: k.createdAt, why: k.why, logoSource: k.logoSource, proposalId: k.mint.slice(0, 16).toLowerCase() } };
  }
  return { role: null, root: null, agent: null, launch: null };
}
export const OWNER_WALLET = OWNER;
