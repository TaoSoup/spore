// Reading the agents' ledger for the site (DESIGN §13.2). `DATA_DIR/agents/ledger.jsonl` is the
// append-only file every fund-moving module writes one line to before and after each action
// (pay.mjs createPaymentLedger: `{ ts, kind, root, ... }`). This reader is its public twin: it
// tails the file incrementally by byte offset (a stat per request at most once a second, then
// only the new bytes), keeps the parsed lines per root in memory, folds the lines of one action
// (launch pending → sent → landed → split landed; claim pending → landed; …) into one item, and
// turns the items into what the coin page and the agent page show: human titles with the coin
// tickers, amounts, the explorer link, and per-agent totals. Malformed lines are counted and
// skipped; a truncated or replaced file is read again from the start; a base64 signature (the
// x402 payments of pay.mjs sign before serialising) is never shown as a transaction link.
//
// Nothing here writes, signs or reads a key: the ledger carries public identifiers only.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { modelInfo } from "./models.mjs";

export const EXPLORER_TX = "https://solscan.io/tx/";
export const ACTIVITY_KINDS = Object.freeze(["launch", "claim", "payout", "aifee", "ai", "swap", "split"]);
/** Item status vocabulary (ledger statuses folded): on-chain actions end landed / failed / expired / uncertain; model calls end done / failed / refused. */
export const ACTIVITY_STATUSES = Object.freeze(["pending", "sent", "step_landed", "landed", "failed", "expired", "uncertain", "done", "refused"]);
const STATUS = { pending: "pending", sent: "sent", landed: "landed", step_landed: "step_landed", tx_failed: "failed", failed: "failed", tx_expired: "expired", expired: "expired", rpc: "uncertain", uncertain: "uncertain", done: "done", settled: "done", refused: "refused" };
const TERMINAL = new Set(["landed", "failed", "expired", "uncertain", "done", "refused"]);
const BS58_SIG = /^[1-9A-HJ-NP-Za-km-z]{64,128}$/;
const LAMPORTS = 1e9, MICROS = 1e6;
const DEFAULTS = Object.freeze({ minRefreshMs: 1000, maxLinesPerRoot: 50_000, maxLineBytes: 16 * 1024 });

/** A base58 transaction signature, or null for anything else (base64, empty, garbage). */
export function bs58Signature(s) { return typeof s === "string" && BS58_SIG.test(s) ? s : null; }
const normStatus = (s) => STATUS[String(s ?? "")] ?? (typeof s === "string" && s ? s.slice(0, 24) : "uncertain");
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const round = (v, d) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

/**
 * Folds the raw lines of one root (oldest first) into items, oldest first. Pure; exported for tests.
 * Item: `{ key, kind, at, updatedAt, status, mint, symbol, name, address, signature, splitSignature, note, …amounts }`
 * where the amounts depend on the kind (see the folders below).
 */
export function foldEntries(lines) {
  const items = new Map();
  const attempts = new Map(); // "launch:<mint>" / "split:<mint>" → how many pending lines so far
  let seq = 0;
  const keyFor = (e) => {
    const sig = bs58Signature(e.signature) ?? (typeof e.signature === "string" && e.signature ? `b64:${e.signature}` : null);
    switch (e.kind) {
      case "launch": case "split": {
        // One item per attempt on a mint: a new "pending" line (a retried split) starts the next one.
        const base = `${e.kind}:${e.mint ?? "?"}`;
        const n = attempts.get(base) ?? 0;
        const attempt = e.status === "pending" || n === 0 ? n + 1 : n;
        attempts.set(base, attempt);
        return `${base}:${attempt}`;
      }
      case "ai":
        if (e.rail === "keyed" || !e.paymentId) return `ai:${seq}`;
        return `ai:${e.paymentId}`;
      default:
        return sig ? `${e.kind}:${sig}` : `${e.kind}:${e.mint ?? e.address ?? "?"}:${seq}`;
    }
  };
  for (const e of lines) {
    seq++;
    const key = keyFor(e);
    let it = items.get(key);
    if (!it) {
      it = { key, kind: e.kind, at: e.ts, updatedAt: e.ts, status: "pending", mint: typeof e.mint === "string" ? e.mint : null, symbol: null, name: null, address: typeof e.address === "string" ? e.address : null, signature: null, splitSignature: null, note: null, seq };
      items.set(key, it);
    }
    it.updatedAt = Math.max(it.updatedAt, e.ts);
    if (!it.mint && typeof e.mint === "string") it.mint = e.mint;
    if (!it.address && typeof e.address === "string") it.address = e.address;
    if (typeof e.note === "string" && e.note) it.note = e.note.slice(0, 200);
    FOLD[e.kind]?.(it, e);
  }
  return [...items.values()];
}

const FOLD = {
  launch(it, e) {
    if (typeof e.symbol === "string" && !it.symbol) it.symbol = e.symbol;
    if (typeof e.name === "string" && !it.name) it.name = e.name;
    if (e.estCostSol != null) it.estCostSol = num(e.estCostSol);
    if (e.txs != null) it.txs = num(e.txs);
    if (e.of != null) it.txs = num(e.of) ?? it.txs;
    const st = normStatus(e.status);
    const step = num(e.step);
    if (step === 2) {
      if (st === "landed") { it.splitDone = true; it.splitSignature = bs58Signature(e.signature) ?? it.splitSignature; }
      else if (TERMINAL.has(st)) it.splitOwed = true;
      it.step2 = st;
    } else {
      // The create transaction (step 1, or the whole launch when it fits one transaction).
      if (st === "landed" || st === "step_landed") { it.created = true; if (st === "landed" && (it.txs ?? 1) === 1) it.splitDone = true; }
      else if (st === "sent") it.sent = true;
      if (bs58Signature(e.signature)) it.signature = e.signature;
      if (e.slot != null) it.slot = num(e.slot);
      if (st !== "pending") it.step1 = st;
    }
    it.status = it.created ? (it.splitDone || (it.txs ?? 1) === 1 ? "landed" : "step_landed") : it.step1 && it.step1 !== "sent" ? it.step1 : it.sent ? "sent" : "pending";
  },
  split(it, e) {
    const st = normStatus(e.status);
    if (bs58Signature(e.signature)) it.signature = e.signature;
    if (e.slot != null) it.slot = num(e.slot);
    it.status = st;
  },
  claim(it, e) {
    if (e.mine != null) it.mineRaw = String(e.mine);
    if (e.total != null) it.totalRaw = String(e.total);
    if (typeof e.sol === "boolean") it.sol = e.sol;
    if (bs58Signature(e.signature)) it.signature = e.signature;
    if (e.slot != null) it.slot = num(e.slot);
    it.status = normStatus(e.status);
  },
  payout(it, e) {
    if (e.lamports != null) it.lamports = num(e.lamports);
    if (e.usdcMicros != null) it.usdcMicros = num(e.usdcMicros);
    if (typeof e.to === "string") it.to = e.to;
    if (bs58Signature(e.signature)) it.signature = e.signature;
    if (e.slot != null) it.slot = num(e.slot);
    it.status = normStatus(e.status);
  },
  aifee(it, e) {
    // The agent paying for its own thinking (aifee.mjs): SOL to the owner for the booked model cost.
    if (e.lamports != null) it.lamports = num(e.lamports);
    if (e.usd != null) it.usd = Number(e.usd);
    if (e.owedUsd != null) it.owedUsd = Number(e.owedUsd);
    if (typeof e.to === "string") it.to = e.to;
    if (bs58Signature(e.signature)) it.signature = e.signature;
    if (e.slot != null) it.slot = num(e.slot);
    it.status = normStatus(e.status);
  },
  swap(it, e) {
    if (e.lamportsIn != null) it.lamportsIn = num(e.lamportsIn);
    if (e.outMicros != null) it.outMicros = num(e.outMicros);
    if (e.minOutMicros != null) it.minOutMicros = num(e.minOutMicros);
    if (bs58Signature(e.signature)) it.signature = e.signature;
    if (e.slot != null) it.slot = num(e.slot);
    it.status = normStatus(e.status);
  },
  ai(it, e) {
    it.rail = e.rail === "keyed" ? "keyed" : "x402";
    if (typeof e.model === "string") it.model = e.model;
    if (typeof e.provider === "string") it.provider = e.provider;
    if (e.image === true) it.image = true;
    if (e.estUsd != null) it.estUsd = num(e.estUsd);
    if (e.amountUsd != null) it.amountUsd = num(e.amountUsd);
    else if (e.amountMicros != null) it.amountUsd = num(e.amountMicros) / MICROS;
    if (e.promptTokens != null) it.promptTokens = num(e.promptTokens);
    if (e.completionTokens != null) it.completionTokens = num(e.completionTokens);
    if (typeof e.paymentId === "string") it.paymentId = e.paymentId;
    it.status = normStatus(e.status);
  },
};

// ---------------------------------------------------------------- formatting
const trimZeros = (s) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
export const fmtSol = (v) => trimZeros(Number(v).toFixed(4));
/** "$0.013", "$0.008", "$0.10", "$1.50": three decimals under a dollar (never fewer than two), two above. */
export const fmtUsd = (v) => { const n = Number(v); if (n >= 1) return n.toFixed(2); const s = trimZeros(n.toFixed(3)); return (s.split(".")[1]?.length ?? 0) < 2 ? n.toFixed(2) : s; };
export const fmtUsdc = (v) => Number(v).toFixed(2);
const fmtUnits = (v) => new Intl.NumberFormat("en-US", { maximumFractionDigits: Number(v) < 1 ? 4 : Number(v) < 1000 ? 2 : 0 }).format(Number(v));
const short = (mint) => (typeof mint === "string" && mint.length > 8 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint ?? "?");

/** What a coin is called in a title: `$TICKER` from the index, else the ledger's own symbol, else a short mint. */
function tickerOf(model, mint, fallback = null) {
  const s = mint ? model?.nameOf?.(mint)?.symbol : null;
  return s ? `$${s}` : fallback ? `$${fallback}` : short(mint);
}
const modelLabel = (id) => modelInfo(id)?.label ?? (typeof id === "string" ? id.replace(/^[a-z]+\//, "") : "the model");

/**
 * One folded item as the API serves it (DESIGN §13.2 ActivityItem). `model` (lib/model.mjs) names
 * coins and prices SOL and quote mints; without it titles fall back to the ledger's own symbols.
 */
export function activityItem(it, { model = null } = {}) {
  const solUsd = model?.solUsd > 0 ? model.solUsd : null;
  const out = { at: it.at, kind: it.kind, status: it.status, title: "", amountSol: null, amountUsdc: null, usd: null, mint: it.mint ?? null, symbol: null, signature: it.signature ?? null, explorer: it.signature ? `${EXPLORER_TX}${it.signature}` : null };
  const sym = (mint, fb) => tickerOf(model, mint, fb);
  const symbolOf = (mint, fb) => (mint ? model?.nameOf?.(mint)?.symbol ?? fb ?? null : fb ?? null);
  switch (it.kind) {
    case "launch": {
      const t = sym(it.mint, it.symbol); out.symbol = symbolOf(it.mint, it.symbol);
      out.amountSol = round(it.estCostSol, 9); out.usd = it.estCostSol != null && solUsd ? round(it.estCostSol * solUsd, 4) : null;
      out.title = it.status === "landed" ? `Launched ${t}` : it.status === "step_landed" ? `Launched ${t} (fee split owed)` : it.status === "failed" ? `Launch of ${t} failed` : it.status === "expired" ? `Launch of ${t} expired` : it.status === "uncertain" ? `Launch of ${t} unconfirmed` : `Launching ${t}`;
      break;
    }
    case "split": {
      const t = sym(it.mint, it.symbol); out.symbol = symbolOf(it.mint, it.symbol);
      out.title = it.status === "landed" ? `Finished the fee split of ${t}` : it.status === "pending" || it.status === "sent" ? `Finishing the fee split of ${t}` : `Fee split of ${t} ${it.status === "uncertain" ? "unconfirmed" : it.status}`;
      break;
    }
    case "claim": {
      const t = sym(it.mint, it.symbol); out.symbol = symbolOf(it.mint, it.symbol);
      const coin = it.mint ? model?.get?.(it.mint) : null;
      const quote = coin ? coin.quoteMint ?? null : null;
      const sol = it.sol ?? (coin ? quote == null : true);
      const raw = it.mineRaw != null ? Number(it.mineRaw) : null;
      let what = "fees";
      if (raw != null && sol) { out.amountSol = round(raw / LAMPORTS, 9); out.usd = solUsd ? round((raw / LAMPORTS) * solUsd, 4) : null; what = `${fmtSol(out.amountSol)} SOL`; }
      else if (raw != null) {
        const dec = quote && model?.decimalsOf ? model.decimalsOf(quote) : 6;
        const units = raw / 10 ** dec;
        const px = quote && model?.quoteUsdOf ? model.quoteUsdOf(quote) : null;
        out.usd = px > 0 ? round(units * px, 4) : null;
        what = `${fmtUnits(units)} ${quote ? sym(quote) : "units"}`;
      }
      out.title = it.status === "landed" ? `Claimed ${what} from ${t}` : it.status === "pending" || it.status === "sent" ? `Claiming ${what} from ${t}` : `Claim from ${t} ${it.status === "uncertain" ? "unconfirmed" : it.status}`;
      break;
    }
    case "payout": {
      out.amountSol = it.lamports != null ? round(it.lamports / LAMPORTS, 9) : null;
      out.amountUsdc = it.usdcMicros ? round(it.usdcMicros / MICROS, 6) : null;
      out.usd = (out.amountSol != null && solUsd) || out.amountUsdc != null ? round((out.amountSol ?? 0) * (solUsd ?? 0) + (out.amountUsdc ?? 0), 4) : null;
      const parts = [out.amountSol ? `${fmtSol(out.amountSol)} SOL` : null, out.amountUsdc ? `${fmtUsdc(out.amountUsdc)} USDC` : null].filter(Boolean);
      const what = parts.length ? parts.join(" + ") : "the surplus";
      out.title = it.status === "landed" ? `Paid ${what} to the owner` : it.status === "pending" || it.status === "sent" ? `Paying ${what} to the owner` : `Payout of ${what} ${it.status === "uncertain" ? "unconfirmed" : it.status}`;
      break;
    }
    case "aifee": {
      out.amountSol = it.lamports != null ? round(it.lamports / LAMPORTS, 9) : null;
      out.usd = it.usd != null ? round(it.usd, 6) : null;
      const what = `${out.usd != null ? `$${fmtUsd(out.usd)}` : "its model cost"}${out.amountSol != null ? ` as ${fmtSol(out.amountSol)} SOL` : ""}`;
      const left = it.owedUsd != null && it.usd != null && it.owedUsd - it.usd > 0.0005 ? ` ($${fmtUsd(it.owedUsd - it.usd)} still owed)` : "";
      out.title = it.status === "landed" ? `Paid its AI fee: ${what} to the owner${left}` : it.status === "pending" || it.status === "sent" ? `Paying its AI fee: ${what}` : `AI fee of ${what} ${it.status === "uncertain" ? "unconfirmed" : it.status}`;
      break;
    }
    case "swap": {
      out.amountSol = it.lamportsIn != null ? round(it.lamportsIn / LAMPORTS, 9) : null;
      const outUsdc = it.outMicros ?? it.minOutMicros ?? null;
      out.amountUsdc = outUsdc != null ? round(outUsdc / MICROS, 6) : null;
      out.usd = out.amountUsdc;
      const what = `${out.amountSol != null ? fmtSol(out.amountSol) : "?"} SOL for ${out.amountUsdc != null ? `≈ ${fmtUsdc(out.amountUsdc)}` : "some"} USDC`;
      out.title = it.status === "landed" ? `Swapped ${what}` : it.status === "pending" || it.status === "sent" ? `Swapping ${what}` : `Swap of ${what} ${it.status === "uncertain" ? "unconfirmed" : it.status}`;
      break;
    }
    case "ai": {
      const usd = it.rail === "keyed" ? it.estUsd : it.amountUsd;
      out.usd = usd != null ? round(usd, 6) : null;
      if (it.rail !== "keyed" && it.amountUsd != null) out.amountUsdc = round(it.amountUsd, 6);
      const cost = out.usd != null ? ` ($${fmtUsd(out.usd)})` : "";
      const label = modelLabel(it.model);
      if (it.status === "done") out.title = it.image ? `Drew a logo${cost}` : `Thought with ${label}${cost}`;
      else if (it.status === "refused") out.title = `Skipped thinking${it.note ? `: ${it.note}` : ""}`;
      else if (it.status === "pending") out.title = it.image ? `Drawing a logo${cost}` : `Thinking with ${label}${cost}`;
      else out.title = `${it.image ? "Logo" : label} call ${it.status === "uncertain" ? "unconfirmed" : it.status}`;
      break;
    }
    default:
      out.title = `${it.kind} ${it.status}`;
  }
  return out;
}

/** Per-agent totals over folded items (DESIGN §13.2). USD values use today's prices from `model`. */
export function totalsOf(items, { model = null } = {}) {
  const t = { launches: 0, launchSol: 0, claimsSol: 0, claimsUsd: 0, aiUsd: 0, aiCalls: 0, payoutsSol: 0, payoutsUsdc: 0, lastActivityAt: null };
  for (const it of items) {
    t.lastActivityAt = Math.max(t.lastActivityAt ?? 0, it.updatedAt ?? it.at ?? 0) || null;
    if (it.kind === "launch" && (it.status === "landed" || it.status === "step_landed")) { t.launches++; t.launchSol += it.estCostSol ?? 0; }
    else if (it.kind === "claim" && it.status === "landed") { const a = activityItem(it, { model }); t.claimsSol += a.amountSol ?? 0; t.claimsUsd += a.usd ?? 0; }
    else if (it.kind === "payout" && it.status === "landed") { t.payoutsSol += it.lamports != null ? it.lamports / LAMPORTS : 0; t.payoutsUsdc += it.usdcMicros != null ? it.usdcMicros / MICROS : 0; }
    else if (it.kind === "ai" && it.status === "done") { t.aiCalls++; t.aiUsd += (it.rail === "keyed" ? it.estUsd : it.amountUsd) ?? 0; }
  }
  for (const k of ["launchSol", "claimsSol", "payoutsSol"]) t[k] = round(t[k], 9);
  for (const k of ["claimsUsd", "aiUsd", "payoutsUsdc"]) t[k] = round(t[k], 4);
  return t;
}

/** Items newest first (by start time, then arrival), as ActivityItems, at most `limit`. */
export function activityOf(items, { model = null, limit = 50 } = {}) {
  return [...items].sort((a, b) => b.at - a.at || b.seq - a.seq).slice(0, Math.max(0, limit)).map((it) => activityItem(it, { model }));
}

/**
 * The incremental reader. `file` is the ledger path (it may not exist yet). `refresh()` is cheap
 * enough to call per request: a `stat` at most once per `minRefreshMs`, then only the new bytes.
 */
export class AgentLedger {
  constructor(file, { log = console, now = Date.now, ...opts } = {}) {
    this.file = file; this.log = log; this.now = now;
    this.opts = { ...DEFAULTS, ...opts };
    this.#reset();
    this.refreshedAt = 0;
  }
  #reset() {
    this.offset = 0; this.tail = Buffer.alloc(0); this.lines = 0; this.bad = 0; this.generation = (this.generation ?? 0) + 1;
    this.byRoot = new Map(); // root → { lines: [], folded: null, foldedAt: -1 }
  }
  /** Reads what was appended since the last call (or everything, after a truncation). Never throws. */
  refresh() {
    const t = this.now();
    if (t - this.refreshedAt < this.opts.minRefreshMs) return this;
    this.refreshedAt = t;
    let st;
    try { st = statSync(this.file); }
    catch (e) { if (e.code === "ENOENT") { if (this.offset) this.#reset(); return this; } this.log.warn?.(`agents: ledger ${this.file}: ${e.message}`); return this; }
    if (st.size < this.offset) { this.log.warn?.(`agents: ledger shrank from ${this.offset} to ${st.size} bytes; reading it again`); this.#reset(); }
    if (st.size === this.offset) return this;
    let fd = null;
    try {
      fd = openSync(this.file, "r");
      const buf = Buffer.allocUnsafe(st.size - this.offset);
      const n = readSync(fd, buf, 0, buf.length, this.offset);
      this.offset += n;
      this.#ingest(buf.subarray(0, n));
    } catch (e) { this.log.warn?.(`agents: ledger read failed: ${e.message}`); }
    finally { if (fd != null) closeSync(fd); }
    return this;
  }
  #ingest(chunk) {
    let buf = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk;
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(0x0a, start);
      if (nl < 0) break;
      this.#line(buf.subarray(start, nl));
      start = nl + 1;
    }
    this.tail = start < buf.length ? Buffer.from(buf.subarray(start)) : Buffer.alloc(0);
    // A partial line longer than any sane entry is garbage, not a write in progress: drop it.
    if (this.tail.length > this.opts.maxLineBytes) { this.bad++; this.tail = Buffer.alloc(0); }
  }
  #line(bytes) {
    if (bytes.length === 0 || (bytes.length === 1 && bytes[0] === 0x0d)) return;
    if (bytes.length > this.opts.maxLineBytes) { this.bad++; return; }
    let e;
    try { e = JSON.parse(bytes.toString("utf8")); } catch { this.bad++; return; }
    if (!e || typeof e !== "object" || Array.isArray(e) || typeof e.kind !== "string" || typeof e.root !== "string" || !e.root) { this.bad++; return; }
    const ts = num(e.ts);
    const entry = { ...e, ts: ts != null && ts > 0 ? Math.floor(ts) : Math.floor(this.now() / 1000) };
    let r = this.byRoot.get(e.root);
    if (!r) { r = { lines: [], folded: null, foldedAt: -1 }; this.byRoot.set(e.root, r); }
    r.lines.push(entry);
    if (r.lines.length > this.opts.maxLinesPerRoot) r.lines.splice(0, r.lines.length - this.opts.maxLinesPerRoot);
    this.lines++;
  }
  /** Raw parsed lines of a root, oldest first (a copy). */
  linesOf(root) { return [...(this.byRoot.get(root)?.lines ?? [])]; }
  roots() { return [...this.byRoot.keys()]; }
  /** Folded items of a root, oldest first; folded once per new line. */
  itemsOf(root) {
    const r = this.byRoot.get(root);
    if (!r) return [];
    if (r.foldedAt !== r.lines.length) { r.folded = foldEntries(r.lines); r.foldedAt = r.lines.length; }
    return r.folded;
  }
  activity(root, { model = null, limit = 50 } = {}) { return activityOf(this.itemsOf(root), { model, limit }); }
  totals(root, { model = null } = {}) { return totalsOf(this.itemsOf(root), { model }); }
  /** For /api/health (no path: the file name is not public information). */
  snapshot() { return { bytes: this.offset, lines: this.lines, bad: this.bad, roots: this.byRoot.size }; }
}
