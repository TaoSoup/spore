// Root agents admin CLI (scripts/agents.mjs) on a real sqlite file: enable (depth-0 only), list,
// rebuild-profile, pause/resume, run-once (a dry run: against a local JSON-RPC double that records
// every method, so the test also proves nothing but reads was attempted), seed and usage errors.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Db } from "../lib/db.mjs";
import { AgentRegistry } from "../lib/agents/registry.mjs";
import { pngSize } from "../lib/agents/logo.mjs";
import { agentTree, K } from "./helpers/agents.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "../scripts/agents.mjs");
let dir, rpcServer, rpcUrl;
const methods = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "spore-agents-cli-"));
  const { db } = agentTree(join(dir, "data", "spore.sqlite"));
  db.close();
  rpcServer = createServer((req, res) => {
    let body = ""; req.on("data", (c) => { body += c; }).on("end", () => {
      const calls = [].concat(JSON.parse(body));
      for (const c of calls) methods.push(c.method);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(calls.map((c) => ({ jsonrpc: "2.0", id: c.id, error: { code: -32000, message: "test rpc down" } }))[0]));
    });
  });
  await new Promise((r) => rpcServer.listen(0, "127.0.0.1", r));
  rpcUrl = `http://127.0.0.1:${rpcServer.address().port}`;
});
after(() => { rpcServer.close(); rmSync(dir, { recursive: true, force: true }); });

function cli(...args) {
  const env = { ...process.env, RPC_URL: rpcUrl, META_DIR: join(dir, "meta"), PAGES_DOMAIN: "spore-2x6.pages.dev" };
  for (const k of ["DATA_DIR", "LLM_URL", "LLM_KEY_FILE", "LLM_MODEL", "LLM_KEY", "AGENTS", "SHOW", "PLATFORM_WALLET", "SPLIT_BPS", "LAUNCH_FEE_SOL"]) delete env[k];
  return new Promise((resolve) => execFile(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args, "--data", join(dir, "data")], { env, timeout: 60_000 }, (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr })));
}

test("enable: a depth-0 root gets an agent and a profile; a child or an unknown coin is refused", async () => {
  const ok = await cli("enable", K.ROOT);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /^enabled \$GROVE agent \(dry run\) — profile fallback: .*mushroom/m);
  assert.match((await cli("enable", K.ROOT)).stdout, /already on: \$GROVE/);
  const child = await cli("enable", K.A);
  assert.equal(child.code, 1); assert.match(child.stderr, /\$SCAT is at depth 1; agents launch only under depth-0 roots/);
  const unknown = await cli("enable", K.X);
  assert.equal(unknown.code, 1); assert.match(unknown.stderr, /is not in the index/);
});

test("list, rebuild-profile, pause and resume", async () => {
  const list = await cli("list");
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /^root\s+mint\s+status\s+score\s+runs\s+proposals\s+last run\s+latest\s+profile/);
  assert.match(list.stdout, new RegExp(`\\$GROVE\\s+${K.ROOT}\\s+dry\\s+\\d+\\s+0\\s+0`));
  const rebuilt = await cli("rebuild-profile", K.ROOT);
  assert.equal(rebuilt.code, 0, rebuilt.stderr);
  const profile = JSON.parse(rebuilt.stdout.slice(rebuilt.stdout.indexOf("{")));
  assert.ok(profile.themes.length >= 3 && profile.summary.length <= 280 && profile.source === "fallback");
  assert.match((await cli("pause", K.ROOT)).stdout, /paused the agent/);
  assert.match((await cli("list")).stdout, /\$GROVE\s+\S+\s+paused/);
  assert.match((await cli("enable", K.ROOT)).stdout, /^resumed \$GROVE/);
  assert.equal((await cli("pause", K.A)).code, 1);
  assert.equal((await cli("rebuild-profile", K.A)).code, 1);
});

test("run-once: a full dry run; the RPC double saw only reads (no send), the proposal and its logo are stored", async () => {
  methods.length = 0;
  const r = await cli("run-once", K.ROOT);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^\$GROVE proposes \$[A-Z0-9]{2,10} ".+" \[rejected: simulation failed: simulation unavailable: getMultipleAccounts: test rpc down/m);
  assert.match(r.stdout, /score \d+: momentum \d+\/100/);
  assert.match(r.stdout, /sim FAILED: - bytes, - CU/);
  assert.ok(methods.length > 0 && methods.every((m) => m === "getMultipleAccounts" || m === "getAccountInfo"), methods.join());
  const db = new Db(join(dir, "data", "spore.sqlite"));
  try {
    const reg = new AgentRegistry(db);
    const p = reg.latest(K.ROOT);
    assert.equal(p.status, "rejected");
    assert.deepEqual(pngSize(readFileSync(join(dir, "data", "agents", p.image_file))), { width: 512, height: 512 });
    assert.equal(reg.get(K.ROOT).proposals, 1);
    assert.match(r.stdout, new RegExp(`served at /api/agents/img/${p.id}\\.png`));
  } finally { db.close(); }
  // --gated: the cooldown now holds it back.
  const gated = await cli("run-once", K.ROOT, "--gated");
  assert.equal(gated.code, 0); assert.match(gated.stdout, /no proposal — cooldown/);
});

test("seed enables the six seed roots it can find; usage errors and a missing database exit 2", async () => {
  const s = await cli("seed");
  assert.equal(s.code, 1, "not every seed root could be enabled here");
  assert.equal((s.stdout.match(/^\$\w+: /gm) ?? []).length, 6);
  assert.equal((s.stdout.match(/not enabled — .* is not in the index/g) ?? []).length, 6, "the seed roots are not in this test tree");
  assert.equal((await cli("bogus")).code, 2);
  assert.equal((await cli("enable")).code, 2);
  const missing = await new Promise((resolve) => execFile(process.execPath, [CLI, "list", "--data", join(dir, "nope")], (err, _o, stderr) => resolve({ code: err?.code, stderr })));
  assert.equal(missing.code, 2); assert.match(missing.stderr, /no database at/);
  assert.ok(!existsSync(join(dir, "nope", "spore.sqlite")), "a typo never creates an empty index");
});
