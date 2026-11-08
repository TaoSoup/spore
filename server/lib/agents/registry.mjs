// Root agents' records (DESIGN §13): `agents` (one row per root: status, profile, run counters) and
// `agent_proposals` (every coin an agent proposed, with its simulation), both in the server's
// sqlite file (tables created in lib/db.mjs). The API views for /api/agents and /v1/agents are built
// here so both routes return the same shapes. Times are unix seconds.
import { scoreRoot, DEFAULTS } from "./scorer.mjs";
import { modelInfo, DEFAULT_MODEL } from "../agents-live/models.mjs";
import { totalsOf, activityOf } from "../agents-live/ledger.mjs";

/** Roots the owner seeded on 2026-10-19 (`scripts/agents.mjs seed`). */
export const SEED_ROOTS = [
  ["SPORE", "HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY"],
  ["GTA", "BsbsB3WLq7vbY5En3MBCAsTrcwaCxNKY2Mp5pGuLpump"],
  ["NTRNDM", "NTRNDMqQSiwEC2jJs3wJiZS6bpGYQJtMNQJgiX3WyV6"],
  ["simulator", "8hnMfF4XL717GVwzDmvqjJvULozKW6w7BhHFABjvHje4"],
  ["DOPE", "33jENUQnjoitkMFpvNJcSHyLAHFWJuHwT6E3E8CNpump"],
  ["VEIL", "HgTGdc29D5bDMrDvsCLnorxz899VyDj7ZN7FPa6vpump"],
];
export const PROPOSALS_PAGE = 50;
export const IMAGE_FILE_RE = /^[0-9a-f]{16}\.png$/;

const parse = (s, d = null) => { if (s == null) return d; try { return JSON.parse(s); } catch { return d; } };
const nowS = () => Math.floor(Date.now() / 1000);

export class AgentRegistry {
  constructor(db, { now = nowS } = {}) {
    this.db = db; this.now = now;
    this.walletCache = new Map(); // root → vault address (decrypting a wallet file costs milliseconds; the address never changes)
    // DESIGN §13.1: the model the creator picked at launch (null = the server default) and the
    // agent's wallet address, once bound. Added here so an older file upgrades on open.
    const cols = new Set(db.db.prepare("PRAGMA table_info(agents)").all().map((c) => c.name));
    if (!cols.has("model")) db.db.exec("ALTER TABLE agents ADD COLUMN model TEXT");
    if (!cols.has("wallet")) db.db.exec("ALTER TABLE agents ADD COLUMN wallet TEXT");
    // Every coin a live agent launched (DESIGN §13.1): survives restarts so fees keep being claimed
    // and an unfinished fee split (second transaction) is retried.
    db.db.exec(`CREATE TABLE IF NOT EXISTS agent_launches (
      mint TEXT PRIMARY KEY, root_mint TEXT NOT NULL, proposal_id TEXT, signature TEXT, created_at INTEGER NOT NULL,
      split_done INTEGER NOT NULL DEFAULT 0, split_sig TEXT, last_claim_at INTEGER, claims INTEGER NOT NULL DEFAULT 0
    ); CREATE INDEX IF NOT EXISTS agent_launches_root ON agent_launches(root_mint, created_at)`);
    const p = (sql) => db.db.prepare(sql);
    this.q = {
      setModel: p("UPDATE agents SET model = ?, updated_at = ? WHERE root_mint = ?"),
      setWallet: p("UPDATE agents SET wallet = ?, updated_at = ? WHERE root_mint = ?"),
      addLaunch: p("INSERT OR IGNORE INTO agent_launches (mint, root_mint, proposal_id, signature, created_at, split_done, split_sig) VALUES (?, ?, ?, ?, ?, ?, ?)"),
      splitDone: p("UPDATE agent_launches SET split_done = 1, split_sig = ? WHERE mint = ?"),
      launches: p("SELECT * FROM agent_launches WHERE root_mint = ? ORDER BY created_at"),
      unsplit: p("SELECT * FROM agent_launches WHERE root_mint = ? AND split_done = 0 ORDER BY created_at"),
      claimed: p("UPDATE agent_launches SET last_claim_at = ?, claims = claims + 1 WHERE mint = ?"),
      launchCount: p("SELECT COUNT(*) AS n FROM agent_launches WHERE root_mint = ?"),
      launch: p("SELECT * FROM agent_launches WHERE mint = ?"),
      launchesDesc: p("SELECT * FROM agent_launches WHERE root_mint = ? ORDER BY created_at DESC, rowid DESC"),
      get: p("SELECT * FROM agents WHERE root_mint = ?"),
      all: p("SELECT * FROM agents ORDER BY created_at, root_mint"),
      insert: p("INSERT INTO agents (root_mint, status, profile_json, created_at, updated_at, next_run_at) VALUES (?, 'dry', ?, ?, ?, ?)"),
      status: p("UPDATE agents SET status = ?, updated_at = ?, next_run_at = CASE WHEN ? = 'dry' THEN COALESCE(next_run_at, ?) ELSE next_run_at END WHERE root_mint = ?"),
      profile: p("UPDATE agents SET profile_json = ?, updated_at = ? WHERE root_mint = ?"),
      run: p("UPDATE agents SET runs = runs + 1, last_run_at = ?, next_run_at = ?, last_score = ?, last_reason = ?, proposals = proposals + ?, updated_at = ? WHERE root_mint = ?"),
      due: p("SELECT * FROM agents WHERE status = 'dry' AND (next_run_at IS NULL OR next_run_at <= ?) ORDER BY COALESCE(next_run_at, 0), root_mint"),
      addProposal: p(`INSERT INTO agent_proposals (id, root_mint, created_at, name, symbol, description, image_file, score, reason, sim_json, status, rejected_reason, source, runners_json, metadata_uri)
        VALUES (@id, @root, @createdAt, @name, @symbol, @description, @imageFile, @score, @reason, @sim, @status, @rejectedReason, @source, @runners, @metadataUri)`),
      proposals: p("SELECT rowid AS seq, * FROM agent_proposals WHERE root_mint = ? ORDER BY created_at DESC, rowid DESC LIMIT ?"),
      proposal: p("SELECT rowid AS seq, * FROM agent_proposals WHERE id = ?"),
      lastAt: p("SELECT MAX(created_at) AS t FROM agent_proposals WHERE root_mint = ?"),
      since: p("SELECT COUNT(*) AS n FROM agent_proposals WHERE created_at > ?"),
      after: p("SELECT rowid AS seq, * FROM agent_proposals WHERE rowid > ? ORDER BY rowid LIMIT 100"),
      maxSeq: p("SELECT COALESCE(MAX(rowid), 0) AS n FROM agent_proposals"),
      imageKnown: p("SELECT 1 FROM agent_proposals WHERE image_file = ?"),
    };
  }

  get(root) { return this.q.get.get(root) ?? null; }
  list() { return this.q.all.all(); }
  /** Creates the agent (status dry, due at once) or turns a paused one back on. Returns the row. */
  enable(root, { profile = null, model = null, wallet = null } = {}) {
    const t = this.now();
    if (!this.get(root)) this.q.insert.run(root, profile ? JSON.stringify(profile) : null, t, t, t);
    else { this.q.status.run("dry", t, "dry", t, root); if (profile) this.setProfile(root, profile); }
    if (model) this.q.setModel.run(String(model), t, root);
    if (wallet) this.q.setWallet.run(String(wallet), t, root);
    return this.get(root);
  }
  /** The model the creator picked for this root's agent (null = the server default). */
  modelOf(root) { return this.get(root)?.model ?? null; }
  walletOf(root) { return this.get(root)?.wallet ?? null; }
  /** A coin the live agent launched; `splitDone` false = the fee split's own transaction is still owed. */
  markLaunched(root, { mint, proposalId = null, signature = null, splitDone = true, splitSig = null, at = this.now() }) {
    this.q.addLaunch.run(mint, root, proposalId, signature, at, splitDone ? 1 : 0, splitSig);
    return this.q.launches.all(root).find((l) => l.mint === mint) ?? null;
  }
  markSplit(mint, signature) { this.q.splitDone.run(signature, mint); }
  markClaimed(mint, at = this.now()) { this.q.claimed.run(at, mint); }
  launchesOf(root) { return this.q.launches.all(root); }
  /** The same rows newest first (what the site lists). */
  launchesOfDesc(root) { return this.q.launchesDesc.all(root); }
  /** The launch record of a coin an agent launched, or null. */
  launchOf(mint) { return this.q.launch.get(mint) ?? null; }
  /**
   * The agent's wallet address: the bound column, else the vault's wallet for this root (the $SPORE
   * agent was bound before the column existed). Null when neither knows one; never a placeholder.
   */
  walletAddress(root, vault = null) {
    const bound = this.walletOf(root);
    if (bound) return bound;
    if (!vault) return null;
    const hit = this.walletCache.get(root);
    if (hit) return hit;
    let address = null;
    try { address = vault.has(root) ? vault.address(root) : null; } catch { address = null; }
    if (address) this.walletCache.set(root, address); // misses are not cached: a wallet made later must show up
    return address;
  }
  unsplitOf(root) { return this.q.unsplit.all(root); }
  launchCount(root) { return this.q.launchCount.get(root).n; }
  pause(root) { const t = this.now(); return Number(this.q.status.run("paused", t, "paused", t, root).changes) > 0; }
  setProfile(root, profile) { this.q.profile.run(JSON.stringify(profile), this.now(), root); }
  profileOf(root) { return parse(this.get(root)?.profile_json); }
  /** Agents whose next evaluation is due (status dry only). */
  due(now = this.now()) { return this.q.due.all(now); }
  /** Counts a run (with or without a proposal) and schedules the next evaluation. */
  recordRun(root, { at = this.now(), nextAt, score = null, reason = null, proposed = false }) { this.q.run.run(at, nextAt, score, reason, proposed ? 1 : 0, at, root); }
  addProposal(p) {
    this.q.addProposal.run({
      id: p.id, root: p.root, createdAt: p.createdAt, name: p.name, symbol: p.symbol, description: p.description, imageFile: p.imageFile ?? null,
      score: p.score, reason: p.reason, sim: p.sim ? JSON.stringify(p.sim) : null, status: p.status ?? "proposed", rejectedReason: p.rejectedReason ?? null,
      source: p.source ?? "fallback", runners: JSON.stringify({ runnersUp: p.runnersUp ?? [], filtered: p.filtered ?? [], rubric: p.rubric ?? null, why: p.why ?? null, logoSource: p.logoSource ?? null }), metadataUri: p.metadataUri ?? null,
    });
    return this.proposal(p.id);
  }
  proposal(id) { return this.q.proposal.get(id) ?? null; }
  proposals(root, limit = PROPOSALS_PAGE) { return this.q.proposals.all(root, limit); }
  latest(root) { return this.q.proposals.all(root, 1)[0] ?? null; }
  lastProposalAt(root) { return this.q.lastAt.get(root)?.t ?? null; }
  /** Proposals created by every agent after `t` (the hourly cap). */
  countSince(t) { return this.q.since.get(t).n; }
  /** Rows written after `seq` (rowid), by this process or another (the CLI): what the runner announces on the event hub. */
  proposalsAfter(seq) { return this.q.after.all(seq); }
  maxSeq() { return this.q.maxSeq.get().n; }
  /** Whether a logo file name belongs to a stored proposal (the image route serves only those). */
  knowsImage(file) { return !!this.q.imageKnown.get(file); }
}

// ---------------------------------------------------------------- views (DESIGN §13 API)
/** Proposal as the API returns it; `base` prefixes the image path ("" on /api, PUBLIC_URL on /v1). */
export function proposalView(row, { base = "" } = {}) {
  const sim = parse(row.sim_json);
  const runners = parse(row.runners_json, {});
  return {
    id: row.id, createdAt: row.created_at, name: row.name, symbol: row.symbol, description: row.description,
    image: row.image_file ? `${base}/api/agents/img/${row.image_file}` : null,
    score: row.score, reason: row.reason,
    sim: { ok: !!sim?.ok, bytes: sim?.bytes ?? null, unitsConsumed: sim?.unitsConsumed ?? null, estCostSol: sim?.estCostSol ?? null, err: sim ? sim.err ?? null : "not simulated" },
    source: row.source === "model" ? "model" : "fallback",
    why: typeof runners.why === "string" && runners.why ? runners.why : null,
    logoSource: runners.logoSource ?? null,
    runnersUp: (runners.runnersUp ?? []).map((r) => ({ name: r.name, symbol: r.symbol })),
    status: row.status, rejectedReason: row.rejected_reason ?? null,
  };
}

/** The metadata description a launch carries: the idea's description plus its hype line (≤ 400 chars). */
export function descriptionWithWhy(idea) {
  const base = String(idea?.description ?? "").trim();
  const why = String(idea?.why ?? "").trim();
  const full = why ? `${base} — Why now: ${why}` : base;
  return full.length > 400 ? full.slice(0, 399).replace(/\s+\S*$/, "") + "…" : full;
}

/** The current momentum of an agent's root, from the live counters (score 0 when the index does not know the coin). */
export function liveScore(model, root, { lastProposalAt = null, now = nowS(), cooldownMin = DEFAULTS.cooldownMin } = {}) {
  const c = model.get(root);
  if (!c) return { score: 0, reason: "root not in the index", parts: null, launchable: false };
  return scoreRoot({ activity: model.activity?.get(root) ?? null, children: model.childrenOf(root).length, depth: c.depth, mayhem: !!c.mayhem, lastProposalAt, now, cooldownMin });
}

// ---------------------------------------------------------------- the site's views (DESIGN §13.2)
export const LAUNCHED_LIST = 12;   // launched coins on an AgentView (the list page)
export const ACTIVITY_LIST = 8;    // activity items on an AgentView
export const ACTIVITY_PAGE = 200;  // activity items on the agent page
const RUNNING = new Set(["dry", "live"]);
const identity = (u) => u;

/**
 * Whether an agent is served at all (DESIGN §13.2): its root is a Spore launch (`model.isOurCoin`),
 * or the owner is running it. A paused agent of a foreign root (the 2026-10-19 seeds) is never public.
 */
export function isPublicAgent(row, model) {
  if (!row) return false;
  if (RUNNING.has(row.status)) return true;
  const c = model.get(row.root_mint);
  return !!(c && model.isOurCoin?.(c));
}

/** The root as a CoinRef (names from the mint table even when the coin is not indexed). */
function rootRef(model, mint, abs = identity) {
  const c = model.get(mint);
  const ref = c ? model.ref(c) : { mint, ...model.nameOf(mint), image: null, depth: 0 };
  return { mint: ref.mint, name: ref.name ?? null, symbol: ref.symbol ?? null, image: abs(ref.image ?? null), depth: ref.depth ?? 0 };
}
const modelOf = (row) => (modelInfo(row.model) ? row.model : DEFAULT_MODEL);
/** The status the site shows: a running row is "live" when the server runs live agents (the row itself stays "dry"). */
const statusOf = (row, mode) => (row.status === "dry" && mode === "live" ? "live" : row.status);
const walletView = (address, bal) => (address ? { address, sol: bal?.sol ?? null, usdc: bal?.usdc ?? null, usd: bal?.usd ?? null, updatedAt: bal?.updatedAt ?? null } : null);

/**
 * The coins an agent launched, newest first, at most `limit`: names and image from the index (a
 * coin the index has not resolved yet falls back to its proposal's name, ticker and logo), the
 * launch signature, and the proposal's hype line and logo source.
 */
export function launchedView(registry, root, { model, abs = identity, limit = Infinity } = {}) {
  const out = [];
  for (const l of registry.launchesOfDesc(root)) {
    if (out.length >= limit) break;
    const p = l.proposal_id ? registry.proposal(l.proposal_id) : null;
    const pv = p ? proposalView(p, { base: "" }) : null;
    const c = model.get(l.mint);
    const names = model.nameOf(l.mint);
    out.push({
      mint: l.mint, name: names.name ?? pv?.name ?? null, symbol: names.symbol ?? pv?.symbol ?? null,
      image: abs((c ? model.ref(c).image : null) ?? pv?.image ?? null),
      createdAt: l.created_at, signature: l.signature ?? null, why: pv?.why ?? null, logoSource: pv?.logoSource ?? null,
    });
  }
  return out;
}

/**
 * One agent as the API returns it (AgentView). `abs` turns same-origin image paths absolute (/v1);
 * `ledger` is the AgentLedger reader (null = no activity, zero totals); `wallets(root, address)`
 * answers the wallet's balances (`{ sol, usdc, usd, updatedAt }` or null); `vault` resolves the
 * address of an agent bound before the wallet column existed; `briefs` (brief.mjs store) says whether
 * the owner gave this agent a brief (its mode and when; the text itself stays on the server).
 */
export function agentView(row, { model, registry, mode = "off", base = "", abs = identity, now = nowS(), cooldownMin = DEFAULTS.cooldownMin, ledger = null, wallets = null, vault = null, liveState = null, briefs = null, launchedLimit = LAUNCHED_LIST, activityLimit = ACTIVITY_LIST }){
  const root = row.root_mint;
  const latest = registry.latest(root);
  const s = liveScore(model, root, { lastProposalAt: latest?.created_at ?? null, now, cooldownMin });
  const address = registry.walletAddress(root, vault);
  const items = ledger ? ledger.itemsOf(root) : [];
  const totals = totalsOf(items, { model });
  totals.launches = Math.max(totals.launches, registry.launchCount(root));
  const mdl = modelOf(row);
  const brief = briefs?.get?.(root) ?? null;
  return {
    root: rootRef(model, root, abs),
    status: statusOf(row, mode),
    profile: parse(row.profile_json),
    stats: { runs: row.runs, proposals: row.proposals, lastRunAt: row.last_run_at ?? null, nextRunAt: RUNNING.has(row.status) ? row.next_run_at ?? null : null, score: s.score, scoreReason: s.reason },
    latest: latest ? proposalView(latest, { base }) : null,
    model: mdl, modelLabel: modelInfo(mdl).label,
    wallet: walletView(address, address && wallets ? wallets(root, address) : null),
    totals,
    launched: launchedView(registry, root, { model, abs, limit: launchedLimit }),
    activity: activityOf(items, { model, limit: activityLimit }),
    // What the live orchestrator thinks right now (null outside AGENTS=live or before its first pass):
    // whether the agent sleeps and the one-line reason ("waiting for fees: 0.013 SOL, a launch needs 0.024").
    sleeping: liveState?.get?.(root)?.sleeping ?? null,
    reason: liveState?.get?.(root)?.reason ?? null,
    owedUsd: liveState?.get?.(root)?.owedUsd ?? null,
    // The owner's standing instruction to this agent (DESIGN §13.3), e.g. { mode: "people" }: every coin is a famous person.
    brief: brief ? { mode: brief.mode ?? "free", setAt: brief.setAt ?? null } : null,
  };
}

/** The short form the coin page gets (`/api/agents/coin/:mint` → `agent`). */
export function agentSummary(row, { model, registry, mode = "off", ledger = null, wallets = null, vault = null }) {
  const root = row.root_mint;
  const address = registry.walletAddress(root, vault);
  const totals = ledger ? ledger.totals(root, { model }) : totalsOf([], { model });
  totals.launches = Math.max(totals.launches, registry.launchCount(root));
  const mdl = modelOf(row);
  return { address, status: statusOf(row, mode), wallet: walletView(address, address && wallets ? wallets(root, address) : null), totals, model: mdl, modelLabel: modelInfo(mdl).label };
}

/** `GET /api/agents` / `/v1/agents` body: public agents only, running ones first, then by current score. */
export function agentsBody({ model, registry, mode, ...opts }) {
  const agents = registry.list().filter((row) => isPublicAgent(row, model)).map((row) => agentView(row, { model, registry, mode, ...opts }));
  const running = (a) => RUNNING.has(a.status);
  agents.sort((a, b) => (running(a) === running(b) ? 0 : running(a) ? -1 : 1) || b.stats.score - a.stats.score || a.root.mint.localeCompare(b.root.mint));
  return { mode, agents };
}

/** `GET /api/agents/:root` / `/v1/agents/:root` body, or null when the root has no public agent. */
export function agentBody(root, { model, registry, base = "", ...opts }) {
  const row = registry.get(root);
  if (!row || !isPublicAgent(row, model)) return null;
  const agent = agentView(row, { model, registry, base, ...opts });
  const items = opts.ledger ? opts.ledger.itemsOf(root) : [];
  return {
    agent,
    proposals: registry.proposals(root, PROPOSALS_PAGE).map((p) => proposalView(p, { base })),
    activity: activityOf(items, { model, limit: ACTIVITY_PAGE }),
    launched: launchedView(registry, root, { model, abs: opts.abs }),
  };
}

/**
 * `GET /api/agents/coin/:mint` body: what the coin page shows. `role` is "root" when the mint has a
 * public agent, "child" when a public agent launched it, else null (never a 404: a coin without
 * an agent is the normal case).
 */
export function agentCoinBody(mint, { model, registry, mode = "off", abs = identity, ledger = null, wallets = null, vault = null }) {
  const none = { role: null, root: null, agent: null, launch: null };
  const summaryOpts = { model, registry, mode, ledger, wallets, vault };
  const own = registry.get(mint);
  if (own && isPublicAgent(own, model)) return { role: "root", root: rootRef(model, mint, abs), agent: agentSummary(own, summaryOpts), launch: null };
  const l = registry.launchOf(mint);
  if (!l) return none;
  const row = registry.get(l.root_mint);
  if (!row || !isPublicAgent(row, model)) return none;
  const p = l.proposal_id ? registry.proposal(l.proposal_id) : null;
  const pv = p ? proposalView(p, { base: "" }) : null;
  return {
    role: "child", root: rootRef(model, l.root_mint, abs), agent: agentSummary(row, summaryOpts),
    launch: { signature: l.signature ?? null, at: l.created_at, why: pv?.why ?? null, logoSource: pv?.logoSource ?? null, proposalId: l.proposal_id ?? null },
  };
}
