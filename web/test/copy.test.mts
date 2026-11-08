// The fee and agent facts the site states, and the phrases that contradict them (redesign
// 2026-10-20). The facts are derived from lib/policy.ts in lib/copy.ts; this checks the derivation
// and scans the source for stale copy.
//   npm test                                   → facts must hold; stale phrases are listed, not fatal
//   COPY_STRICT=1 npm test                     → any stale phrase fails (the integration gate)
//   COPY_STRICT=1 COPY_FILES=src/pages/Home.tsx,src/pages/How.tsx npm test   → strict for one lane's files
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_CADENCE, BANNED_PHRASES, CHILD_PCT, CHILD_SPLIT_LINE, META_DESCRIPTION, NO_LAUNCH_FEE, OFFICIAL_CA, ROOT_FEE_SHARE, ROOT_PCT, ROOT_SPLIT_LINE } from "../src/lib/copy.ts";

const WEB = fileURLToPath(new URL("..", import.meta.url));

test("root split reads creator 0.25% / Spore 0.50% / agent 0.20% of every trade", () => {
  assert.deepEqual(ROOT_PCT, { creator: "0.25%", spore: "0.50%", agent: "0.20%" });
  assert.deepEqual(ROOT_FEE_SHARE, { creator: "26.32%", spore: "52.63%", agent: "21.05%" });
  assert.equal(ROOT_SPLIT_LINE, "creator 0.25% · Spore 0.50% · the root's agent 0.20% of every trade once graduated (0.30% tier on the curve)");
});
test("child split reads creator 50% / Spore 50%, paid in the parent coin", () => {
  assert.deepEqual(CHILD_PCT, { creator: "50%", spore: "50%" });
  assert.equal(CHILD_SPLIT_LINE, "creator 50% · Spore 50%, paid in the parent coin");
});
test("agent cadence, launch fee and the official CA", () => {
  assert.equal(AGENT_CADENCE, "every 3 minutes");
  assert.equal(NO_LAUNCH_FEE, "No launch fee, only network rent.");
  assert.equal(OFFICIAL_CA, "HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY");
});

// index.html cannot import copy.ts, so its three descriptions are checked against META_DESCRIPTION here.
test("index.html descriptions are META_DESCRIPTION verbatim", () => {
  const html = readFileSync(join(WEB, "index.html"), "utf8");
  for (const sel of ['name="description"', 'property="og:description"', 'name="twitter:description"']) {
    const m = html.match(new RegExp(`<meta ${sel} content="([^"]*)"`));
    assert.ok(m, `index.html has no <meta ${sel}>`);
    assert.equal(m[1], META_DESCRIPTION, `<meta ${sel}> differs from META_DESCRIPTION`);
  }
});

const SKIP = [/^src\/lib\/copy\.ts$/, /^src\/lib\/pump\//, /^src\/components\/map\//, /^src\/lib\/map\//];
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|html)$/.test(name)) out.push(p);
  }
  return out;
}
test("no copy contradicts the facts", (t) => {
  const only = (process.env.COPY_FILES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const files = [...walk(join(WEB, "src")), join(WEB, "index.html")]
    .map((p) => relative(WEB, p).split("\\").join("/"))
    .filter((r) => !SKIP.some((re) => re.test(r)) && (!only.length || only.includes(r)));
  const hits: string[] = [];
  for (const r of files) {
    readFileSync(join(WEB, r), "utf8").split("\n").forEach((line, i) => {
      const low = line.toLowerCase();
      for (const ph of BANNED_PHRASES) if (low.includes(ph.toLowerCase())) hits.push(`${r}:${i + 1}  "${ph}"`);
    });
  }
  if (hits.length) t.diagnostic(`stale copy:\n${hits.join("\n")}`);
  if (process.env.COPY_STRICT) assert.deepEqual(hits, [], `stale copy:\n${hits.join("\n")}`);
});
