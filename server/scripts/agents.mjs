// Root agents admin (DESIGN §13). No HTTP admin endpoint exists; this CLI is the only way to turn an
// agent on or off, rebuild what it knows about its root, or make it run once now.
//
//   node --disable-warning=ExperimentalWarning scripts/agents.mjs enable <rootMint>
//   node --disable-warning=ExperimentalWarning scripts/agents.mjs pause <rootMint>
//   node --disable-warning=ExperimentalWarning scripts/agents.mjs rebuild-profile <rootMint>
//   node --disable-warning=ExperimentalWarning scripts/agents.mjs run-once <rootMint> [--gated]
//   node --disable-warning=ExperimentalWarning scripts/agents.mjs list
//   node --disable-warning=ExperimentalWarning scripts/agents.mjs seed            (enables the six seed roots)
//
// It opens DATA_DIR/spore.sqlite (`--data <dir>` overrides; the file must exist) next to the running
// server and reads the same environment as the server (RPC_URL, LLM_*, PLATFORM_WALLET, SPLIT_BPS,
// LAUNCH_FEE_SOL, PAGES_DOMAIN, AGENT_*). `run-once` is a dry run like the server's loop: it builds
// and simulates the launch, never signs or sends. It skips the score/cooldown/hourly gates unless
// `--gated` is given (the reason still says what the gates would have done). Logos are written to
// DATA_DIR/agents, where the server serves them; a running server announces the new proposal on its
// event stream within one tick.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../lib/config.mjs";
import { Db } from "../lib/db.mjs";
import { Model } from "../lib/model.mjs";
import { Rpc } from "../lib/rpc.mjs";
import { AgentRegistry, SEED_ROOTS, liveScore } from "../lib/agents/registry.mjs";
import { AgentRunner } from "../lib/agents/runner.mjs";
import { createLlm } from "../lib/agents/llm.mjs";
import { buildProfile, profileInput } from "../lib/agents/profile.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (k) => { const i = argv.indexOf(`--${k}`); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const bare = (k) => { const i = argv.indexOf(`--${k}`); if (i < 0) return false; argv.splice(i, 1); return true; };
const dataDir = resolve(flag("data") ?? process.env.DATA_DIR ?? join(here, "../data"));
const gated = bare("gated");
const [cmd, arg] = argv;
const COMMANDS = ["enable", "pause", "rebuild-profile", "run-once", "list", "seed"];
const usage = () => { console.error(`usage: agents.mjs ${COMMANDS.slice(0, 4).map((c) => `${c} <rootMint>`).join(" | ")} [--gated] | list | seed   [--data <dir>]`); process.exit(2); };
if (!COMMANDS.includes(cmd) || (["enable", "pause", "rebuild-profile", "run-once"].includes(cmd) && !arg)) usage();

const file = join(dataDir, "spore.sqlite");
if (!existsSync(file)) { console.error(`no database at ${file} (set DATA_DIR or --data)`); process.exit(2); }
let cfg;
try { cfg = loadConfig({ ...process.env, DATA_DIR: dataDir }, { here: join(here, "..") }); }
catch (e) { console.error(`agents: ${e.message}`); process.exit(2); }

const quiet = { info() {}, warn: (m) => console.error(`warn: ${m}`), error: (m) => console.error(`error: ${m}`) };
const db = new Db(file, { busyMs: 5_000 });
const registry = new AgentRegistry(db);
const iso = (s) => (s ? new Date(s * 1000).toISOString().replace(".000Z", "Z") : "-");
const table = (rows, cols) => {
  const w = cols.map(([h, f]) => Math.max(h.length, ...rows.map((r) => String(f(r)).length)));
  console.log(cols.map(([h], i) => h.padEnd(w[i])).join("  "));
  for (const r of rows) console.log(cols.map(([, f], i) => String(f(r)).padEnd(w[i])).join("  "));
};
let model = null;
const loadModel = () => {
  if (model) return model;
  model = new Model(db, { platformWallet: cfg.platformWallet, splitBps: cfg.splitBps, platformMinBps: cfg.platformMinBps, mode: cfg.show, log: quiet });
  model.load();
  return model;
};
const llm = () => createLlm({ url: cfg.llm.url, keyFile: cfg.llm.keyFile, model: cfg.llm.model, log: quiet });
const label = (m, mint) => { const s = m?.nameOf(mint)?.symbol; return s ? `$${s}` : mint.slice(0, 8) + "…"; };

/** Refuses roots the index does not know or that cannot take children here (depth 0 only). */
function checkRoot(m, mint) {
  const c = m.get(mint);
  if (!c) return `${mint} is not in the index (only indexed depth-0 coins can have an agent)`;
  if (c.depth !== 0) return `${label(m, mint)} is at depth ${c.depth}; agents launch only under depth-0 roots`;
  if (c.mayhem) return `${label(m, mint)} is a mayhem-mode coin, which cannot be a parent`;
  return null;
}
/** Enables one agent; returns the line to print, or throws with the reason it was refused. */
async function enable(m, mint) {
  const bad = checkRoot(m, mint);
  if (bad) throw new Error(bad);
  const known = registry.get(mint);
  const profile = known?.profile_json ? null : await buildProfile(profileInput(m, mint), { llm: llm(), log: quiet });
  registry.enable(mint, { profile });
  const p = registry.profileOf(mint);
  return `${known ? (known.status === "paused" ? "resumed" : "already on:") : "enabled"} ${label(m, mint)} agent (dry run) — profile ${p?.source ?? "?"}: ${p?.themes?.join(", ") ?? "-"}`;
}

try {
  if (cmd === "list") {
    const rows = registry.list();
    if (!rows.length) console.log("no agents");
    else {
      const m = loadModel();
      table(rows.map((r) => ({ ...r, latest: registry.latest(r.root_mint), live: liveScore(m, r.root_mint, { lastProposalAt: registry.lastProposalAt(r.root_mint), cooldownMin: cfg.agents.cooldownMin }) })), [
        ["root", (r) => label(m, r.root_mint)], ["mint", (r) => r.root_mint], ["status", (r) => r.status], ["score", (r) => r.live.score], ["runs", (r) => r.runs], ["proposals", (r) => r.proposals],
        ["last run", (r) => iso(r.last_run_at)], ["latest", (r) => (r.latest ? `$${r.latest.symbol} (${r.latest.status})` : "-")], ["profile", (r) => (r.profile_json ? JSON.parse(r.profile_json).source : "-")],
      ]);
    }
  } else if (cmd === "pause") {
    if (registry.pause(arg)) console.log(`paused the agent of ${arg}; it stays visible read-only`); else { console.error(`no agent for ${arg}`); process.exitCode = 1; }
  } else if (cmd === "enable") {
    try { console.log(await enable(loadModel(), arg)); } catch (e) { console.error(e.message); process.exitCode = 1; }
  } else if (cmd === "seed") {
    const m = loadModel();
    for (const [sym, mint] of SEED_ROOTS) {
      try { console.log(`$${sym}: ${await enable(m, mint)}`); } catch (e) { console.log(`$${sym}: not enabled — ${e.message}`); process.exitCode = 1; }
    }
  } else if (cmd === "rebuild-profile") {
    const m = loadModel();
    if (!registry.get(arg)) { console.error(`no agent for ${arg} (enable it first)`); process.exitCode = 1; }
    else {
      const p = await buildProfile(profileInput(m, arg), { llm: llm(), log: quiet });
      registry.setProfile(arg, p);
      console.log(`rebuilt the profile of ${label(m, arg)} (${p.source})`);
      console.log(JSON.stringify(p, null, 2));
    }
  } else if (cmd === "run-once") {
    const m = loadModel();
    if (!registry.get(arg)) { console.error(`no agent for ${arg} (enable it first)`); process.exitCode = 1; }
    else {
      const rpc = new Rpc({ url: cfg.rpcUrl, rps: Math.min(cfg.rpcRps, 10), concurrency: 2, log: quiet });
      const runner = new AgentRunner({ registry, model: m, rpc: rpc.lane("api"), llm: llm(), log: quiet,
        cfg: { ...cfg.agents, mode: "dry", platformWallet: cfg.platformWallet, splitBps: cfg.splitBps, launchFeeSol: cfg.launchFeeSol, pagesDomain: cfg.pagesDomain, dataDir } });
      const r = await runner.runAgent(arg, { force: !gated });
      if (r.skipped) console.log(`${label(m, arg)}: no proposal — ${r.skipped}${r.reason ? ` (${r.reason})` : ""}`);
      else {
        const p = r.proposal;
        console.log(`${label(m, arg)} proposes $${p.symbol} "${p.name}" [${p.status}${p.rejectedReason ? `: ${p.rejectedReason}` : ""}]`);
        console.log(`  ${p.description}`);
        console.log(`  score ${p.score}: ${p.reason}`);
        console.log(`  sim ${p.sim.ok ? "ok" : "FAILED"}: ${p.sim.bytes ?? "-"} bytes, ${p.sim.unitsConsumed ?? "-"} CU, est. ${p.sim.estCostSol ?? "-"} SOL${p.sim.err ? `, ${p.sim.err}` : ""}`);
        console.log(`  source ${p.source}; runners-up ${p.runnersUp.map((x) => `$${x.symbol}`).join(", ") || "-"}`);
        console.log(`  logo ${join(dataDir, "agents", `${p.id}.png`)} (served at ${p.image})`);
      }
    }
  }
} finally { db.db.close(); }
