// Owner briefs for root agents (DESIGN §13.3): a standing instruction one root's agent follows on
// every run, above its root's themes. No HTTP endpoint writes briefs; this CLI is the only way.
//
//   node --disable-warning=ExperimentalWarning scripts/agent-brief.mjs set <rootMint> "<text>" [--mode people|free]
//   node --disable-warning=ExperimentalWarning scripts/agent-brief.mjs set <rootMint> --file <path | -> [--mode people|free]
//   node --disable-warning=ExperimentalWarning scripts/agent-brief.mjs get <rootMint>
//   node --disable-warning=ExperimentalWarning scripts/agent-brief.mjs clear <rootMint>
//   node --disable-warning=ExperimentalWarning scripts/agent-brief.mjs list
//
// The file is DATA_DIR/agents/briefs.json (`--data <dir>` overrides; default server/data), written
// atomically with mode 600. `--file -` reads the text from standard input. `--mode people`: every
// coin the agent launches is one famous real person (name = full name, ticker = the name they go
// by), one per coin, never twice. A running server picks a change up on the agent's next run.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { briefsFile, readBriefsFile, setBrief, clearBrief, validBriefs, isMint, BriefError, BRIEF_MODES } from "../lib/agents/brief.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (k) => { const i = argv.indexOf(`--${k}`); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const dataDir = resolve(flag("data") ?? process.env.DATA_DIR ?? join(here, "../data"));
const mode = flag("mode");
const fromFile = flag("file");
const [cmd, root, ...rest] = argv;
const COMMANDS = ["set", "get", "clear", "list"];
const usage = () => { console.error(`usage: agent-brief.mjs set <rootMint> "<text>" | --file <path|-> [--mode ${BRIEF_MODES.join("|")}] | get <rootMint> | clear <rootMint> | list   [--data <dir>]`); process.exit(2); };
if (!COMMANDS.includes(cmd) || (cmd !== "list" && !root)) usage();
if (cmd !== "list" && !isMint(root)) { console.error(`not a mint: ${root}`); process.exit(2); }
const file = briefsFile(dataDir);
const fail = (e) => { console.error(e instanceof BriefError ? `refused: ${e.message}` : `agent-brief: ${e.message ?? e}`); process.exit(1); };
const iso = (s) => (s ? new Date(s * 1000).toISOString().replace(".000Z", "Z") : "-");

try {
  if (cmd === "set") {
    let text = rest.join(" ");
    if (fromFile !== undefined) {
      if (rest.length) usage();
      text = readFileSync(fromFile === "-" ? 0 : fromFile, "utf8");
    }
    if (!text.trim()) usage();
    const b = setBrief(file, root, { text, mode: mode ?? "free" });
    console.log(`brief set for ${root} (mode ${b.mode}, ${b.text.length} characters) in ${file}`);
    console.log(b.text);
  } else if (cmd === "get") {
    const { briefs } = validBriefs(readBriefsFile(file));
    const b = briefs[root];
    if (!b) { console.error(`no brief for ${root}`); process.exit(1); }
    console.log(JSON.stringify({ root, ...b, setAtIso: iso(b.setAt) }, null, 2));
  } else if (cmd === "clear") {
    console.log(clearBrief(file, root) ? `brief cleared for ${root}` : `no brief for ${root}`);
  } else {
    const { briefs, bad } = validBriefs(readBriefsFile(file));
    const rows = Object.entries(briefs);
    if (!rows.length) console.log("no briefs");
    for (const [r, b] of rows) console.log(`${r}  ${b.mode.padEnd(6)}  ${iso(b.setAt)}  ${b.text.replace(/\s+/g, " ").slice(0, 80)}${b.text.length > 80 ? "…" : ""}`);
    if (bad.length) console.error(`warn: ${bad.length} invalid entr${bad.length === 1 ? "y" : "ies"} ignored: ${bad.join(", ")}`);
  }
} catch (e) { fail(e); }
