// Owner briefs for root agents (DESIGN §13.3; owner 2026-10-20: "the $HUMAN agent launches the
// world's famous people"). A brief is a standing instruction the owner gives one root's agent; the
// designer puts it in the model prompt as the governing instruction, above the root's themes.
//
// Stored in DATA_DIR/agents/briefs.json (mode 600, written atomically by scripts/agent-brief.mjs):
//   { "<rootMint>": { "text": "...", "mode": "people" | "free", "setAt": <unix s> } }
// `mode` "people": every coin is one famous real person (name = full name, ticker = the name they
// are known by); "free" (the default): the text alone steers the ideas.
//
// The file is read again whenever it changes (stat on every lookup, parsed only when its mtime,
// size or inode moved), so a brief set from the CLI applies on the agent's next run without a
// restart. Entries that do not validate are ignored, never half-used.
import { readFileSync, writeFileSync, renameSync, statSync, mkdirSync, chmodSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";

export const BRIEF_MAX = 1_200;
export const BRIEF_MODES = Object.freeze(["people", "free"]);
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const LINK_RE = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|io|xyz|fun|net|org|gg|app|dev|ly)\b|\]\(/i;
const MARKUP_RE = /[<>`]/;
// Control characters other than tab and newline.
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/;

export class BriefError extends Error { constructor(message) { super(message); this.name = "BriefError"; } }

/** The briefs file of a data directory. */
export const briefsFile = (dataDir) => join(dataDir, "agents", "briefs.json");
export const isMint = (s) => typeof s === "string" && MINT_RE.test(s);

/** `{ text, mode }` cleaned, or throws BriefError: text 1-1 200 characters of plain text (no links, no markup), mode people | free. */
export function cleanBrief({ text, mode = "free" } = {}) {
  if (typeof text !== "string") throw new BriefError("the brief must be text");
  const t = text.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!t) throw new BriefError("the brief is empty");
  if (t.length > BRIEF_MAX) throw new BriefError(`the brief is ${t.length} characters; at most ${BRIEF_MAX}`);
  if (CONTROL_RE.test(t)) throw new BriefError("the brief contains control characters");
  if (MARKUP_RE.test(t)) throw new BriefError("the brief must be plain text (no <, > or backticks)");
  if (LINK_RE.test(t)) throw new BriefError("the brief must not contain links");
  const m = mode == null ? "free" : String(mode).toLowerCase();
  if (!BRIEF_MODES.includes(m)) throw new BriefError(`mode must be one of ${BRIEF_MODES.join(", ")}`);
  return { text: t, mode: m };
}

/** Every valid entry of a parsed briefs object (invalid ones are dropped and named in `bad`). */
export function validBriefs(raw) {
  const out = {}, bad = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { briefs: out, bad: raw == null ? [] : ["(file is not an object)"] };
  for (const [root, v] of Object.entries(raw)) {
    try {
      if (!isMint(root)) throw new BriefError("not a mint");
      const b = cleanBrief({ text: v?.text, mode: v?.mode });
      out[root] = { ...b, setAt: Number.isInteger(v?.setAt) ? v.setAt : null };
    } catch { bad.push(root); }
  }
  return { briefs: out, bad };
}

/** The raw file as an object ({} when missing); throws on unreadable or malformed JSON. */
export function readBriefsFile(file) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return {}; throw e; }
  if (!text.trim()) return {};
  return JSON.parse(text);
}

/** Writes the whole object atomically (temp file in the same directory, mode 600, then rename). */
export function writeBriefsFile(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (e) { try { unlinkSync(tmp); } catch { /* not written */ } throw e; }
}

/** Sets (or replaces) the brief of `root`; returns the stored entry. */
export function setBrief(file, root, { text, mode = "free", now = Math.floor(Date.now() / 1000) } = {}) {
  if (!isMint(root)) throw new BriefError("root must be a mint (base58)");
  const b = cleanBrief({ text, mode });
  const all = readBriefsFile(file);
  all[root] = { text: b.text, mode: b.mode, setAt: now };
  writeBriefsFile(file, all);
  return all[root];
}

/** Removes the brief of `root`; true when there was one. */
export function clearBrief(file, root) {
  const all = readBriefsFile(file);
  if (!(root in all)) return false;
  delete all[root];
  writeBriefsFile(file, all);
  return true;
}

/**
 * A reader over one data directory: `get(root)` → `{ text, mode, setAt }` or null, `all()` → every
 * valid brief. The file is re-read only when it changed; a malformed file means no briefs (warned
 * once per change) rather than a crash in the agent loop or the API.
 */
export function createBriefStore(dataDir, { log = console, file = briefsFile(dataDir) } = {}) {
  let stamp = null, cache = {};
  const load = () => {
    let st = null;
    try { st = statSync(file); } catch (e) { if (e.code !== "ENOENT") log.warn?.(`agents: briefs file unreadable (${e.code ?? "error"})`); }
    const s = st ? `${st.mtimeMs}:${st.size}:${st.ino}` : "none";
    if (s === stamp) return cache;
    stamp = s;
    if (!st) { cache = {}; return cache; }
    try {
      const { briefs, bad } = validBriefs(readBriefsFile(file));
      if (bad.length) log.warn?.(`agents: ${bad.length} brief${bad.length === 1 ? "" : "s"} ignored (invalid): ${bad.slice(0, 3).join(", ")}`);
      cache = briefs;
    } catch (e) {
      log.warn?.(`agents: briefs file ignored (${String(e.message ?? e).slice(0, 120)})`);
      cache = {};
    }
    return cache;
  };
  return {
    file,
    get(root) { return load()[root] ?? null; },
    all() { return { ...load() }; },
  };
}
