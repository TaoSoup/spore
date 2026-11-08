// The root agents' loop (DESIGN §13, phase 0: dry run). With AGENTS=dry the server evaluates every
// enabled agent each AGENT_TICK_SEC; AGENTS=off (the default) starts nothing. One run:
//   profile (built once) → momentum score → gates (minimum score, per-root cooldown, hourly cap
//   across agents) → six ideas, filtered and ranked → logo → the metadata URI the launch would use
//   → the exact launch transaction, built and simulated (never signed, never sent) → stored proposal
//   → `agent` event on the SSE hub.
// Runs are strictly one at a time (a promise chain), started from a timer the indexer never waits
// on; the only work between awaits is a few milliseconds of scoring, filtering and rasterising.
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { buildProfile, profileInput } from "./profile.mjs";
import { gate, DEFAULTS } from "./scorer.mjs";
import { design, designContext } from "./designer.mjs";
import { renderLogo } from "./logo.mjs";
import { simulateLaunch, agentPlaceholder } from "./simulate.mjs";
import { liveScore, proposalView } from "./registry.mjs";
import { purposeDescription, agentSiteUrl } from "./purpose.mjs";
import { createBriefStore } from "./brief.mjs";
import { personKey } from "./people.mjs";
import { metaFiles } from "../metahost.mjs";
import { splitShares, launchFeeOf } from "../pricing.mjs";
import { NO_LLM } from "./llm.mjs";

export const AGENT_DEFAULTS = { mode: "off", tickSec: 300, ...DEFAULTS };
const FIRST_TICK_MS = 15_000;

export class AgentRunner {
  /**
   * `cfg`: { mode, tickSec, minScore, cooldownMin, maxPerHour, platformWallet, splitBps, launchFeeSol,
   * pagesDomain, dataDir, probe }. `rpc` is the lane agents read and simulate on (wrapped read-only
   * by simulate.mjs). `briefs` is the owner-brief reader (brief.mjs; default: DATA_DIR/agents/briefs.json,
   * none without a data directory). `simulate`, `render` and `newId` are seams for tests.
   */
  constructor({ registry, model, rpc, hub = null, llm = NO_LLM, cfg = {}, log = console, now = () => Math.floor(Date.now() / 1000), simulate = simulateLaunch, render = renderLogo, newId = () => randomBytes(8).toString("hex"), briefs = undefined }) {
    this.registry = registry; this.model = model; this.rpc = rpc; this.hub = hub; this.llm = llm; this.log = log; this.now = now;
    this.cfg = { ...AGENT_DEFAULTS, ...Object.fromEntries(Object.entries(cfg).filter(([, v]) => v != null)) };
    this.simulate = simulate; this.render = render; this.newId = newId;
    this.imgDir = join(this.cfg.dataDir ?? ".", "agents");
    this.briefs = briefs !== undefined ? briefs : this.cfg.dataDir ? createBriefStore(this.cfg.dataDir, { log }) : null;
    this.chain = Promise.resolve();
    this.timer = null; this.firstTimer = null; this.ticking = false; this.stopped = false;
    this.lastSeq = 0;
    this.stats = { ticks: 0, skippedTicks: 0, runs: 0, proposals: 0, gated: 0, failures: 0, lastTickAt: null, lastError: null };
  }

  get enabled() { return this.cfg.mode === "dry"; }

  /** Starts the loop when AGENTS=dry; anything else (off) starts nothing at all. */
  start() {
    if (!this.enabled || this.timer) return this;
    this.lastSeq = this.registry.maxSeq();
    this.firstTimer = setTimeout(() => this.tick(), FIRST_TICK_MS); this.firstTimer.unref?.();
    this.timer = setInterval(() => this.tick(), this.cfg.tickSec * 1000); this.timer.unref?.();
    this.log.info?.(`agents: dry run every ${this.cfg.tickSec} s (min score ${this.cfg.minScore}, cooldown ${this.cfg.cooldownMin} min, ${this.cfg.maxPerHour}/h cap, language model ${this.llm.available ? this.llm.model : "off: fallback"})`);
    return this;
  }
  stop() { this.stopped = true; clearInterval(this.timer); clearTimeout(this.firstTimer); this.timer = null; }

  /** Serialises every run: at most one agent works at any time. */
  #serial(job) { const p = this.chain.then(job, job); this.chain = p.catch(() => {}); return p; }

  /** One pass: announce proposals other processes wrote, then evaluate each due agent in turn. */
  async tick() {
    if (!this.enabled || this.stopped) return;
    if (this.ticking) { this.stats.skippedTicks++; return; }
    this.ticking = true; this.stats.ticks++; this.stats.lastTickAt = this.now();
    try {
      this.announce();
      for (const row of this.registry.due(this.now())) {
        if (this.stopped || !this.enabled) break;
        try { await this.runAgent(row.root_mint); }
        catch (e) { this.stats.failures++; this.stats.lastError = String(e.message ?? e).slice(0, 200); this.log.warn?.(`agents: ${row.root_mint}: run failed: ${this.stats.lastError}`); }
        await new Promise((r) => setImmediate(r));
      }
    } finally { this.ticking = false; }
  }

  /** Emits `agent` for stored proposals not announced yet (the CLI writes to the same file). */
  announce() {
    for (const row of this.registry.proposalsAfter(this.lastSeq)) { this.lastSeq = Math.max(this.lastSeq, row.seq); this.hub?.emit("agent", { root: row.root_mint, proposal: proposalView(row) }); }
  }

  /** The agent's profile, built and stored on first use (or again with `rebuild`). */
  async profile(root, { rebuild = false } = {}) {
    const known = rebuild ? null : this.registry.profileOf(root);
    if (known) return known;
    const p = await buildProfile(profileInput(this.model, root), { llm: this.llm, log: this.log, now: this.now() });
    this.registry.setProfile(root, p);
    return p;
  }

  /**
   * One run of one agent. `force` (the CLI's run-once) skips the gates but still records the score
   * and why the gates would have refused. Resolves to `{ proposal }` (the API view) or `{ skipped }`.
   */
  runAgent(root, { force = false } = {}) { return this.#serial(() => this.#run(root, { force })); }

  async #run(root, { force }) {
    const cfg = this.cfg, t = this.now();
    const agent = this.registry.get(root);
    if (!agent) throw new Error(`no agent for ${root}`);
    const coin = this.model.get(root);
    if (!coin) throw new Error(`root ${root} is not in the index`);
    this.stats.runs++;
    const nextAt = t + cfg.tickSec;
    const lastAt = this.registry.lastProposalAt(root);
    const s = liveScore(this.model, root, { lastProposalAt: lastAt, now: t, cooldownMin: cfg.cooldownMin });
    const g = gate({ score: s.score, launchable: s.launchable, lastProposalAt: lastAt, proposalsLastHour: this.registry.countSince(t - 3600), now: t, minScore: cfg.minScore, cooldownMin: cfg.cooldownMin, maxPerHour: cfg.maxPerHour });
    if (!s.launchable || (!g.ok && !force)) {
      this.stats.gated++;
      this.registry.recordRun(root, { at: t, nextAt, score: s.score, reason: `${s.reason}; not proposing: ${g.why}` });
      return { skipped: g.why, score: s.score, reason: s.reason };
    }
    const profile = await this.profile(root);
    const ctx = designContext(this.model, root);
    // The owner's brief (DESIGN §13.3), read fresh each run so a brief set from the CLI applies at once.
    const brief = this.briefs?.get(root) ?? null;
    ctx.brief = brief ? { text: brief.text, mode: brief.mode ?? "free" } : null;
    // Never the same coin twice: the agent's own recent proposals count as taken tickers (and, for a
    // people brief, as taken people).
    const recent = this.registry.proposals(root);
    ctx.proposedSymbols = new Set(recent.map((p) => p.symbol));
    ctx.proposedNames = new Set(recent.map((p) => personKey(p.name)).filter(Boolean));
    ctx.proposedLabels = recent.map((p) => ({ name: p.name, symbol: p.symbol }));
    const people = ctx.brief?.mode === "people";
    // The proposal id (random) seeds the generator: two runs of one root never repeat each other,
    // even the loop and the CLI in the same second.
    const id = this.newId();
    const d = await design(profile, { mint: root, name: ctx.rootName, symbol: ctx.rootSymbol }, ctx, { llm: this.llm, log: this.log, seed: id });
    if (!d.best) {
      this.registry.recordRun(root, { at: t, nextAt, score: s.score, reason: `${s.reason}; no idea passed the filters (${d.considered} considered)` });
      return { skipped: "no candidate passed the filters", filtered: d.filtered };
    }
    const png = await this.render({ symbol: d.best.symbol, name: d.best.name, description: d.best.description, why: d.best.why ?? null, palette: profile.palette, seed: id, ...(people ? { mode: "people" } : {}) });
    mkdirSync(this.imgDir, { recursive: true });
    const file = `${id}.png`, tmp = join(this.imgDir, `.${file}.tmp`);
    writeFileSync(tmp, png); renameSync(tmp, join(this.imgDir, file));
    // The URI the launch would carry: our metadata host's content address for this exact JSON + logo
    // (computed, not published), so the simulated transaction has the real length.
    // Every agent coin says what it is for (pumping its root) and links to the root agent's page.
    const meta = metaFiles({ name: d.best.name, symbol: d.best.symbol, description: purposeDescription(d.best, ctx.rootSymbol, { tribute: people ? d.best.name : null }), website: agentSiteUrl(root, cfg.publicUrl), imageBytes: png, imageType: "image/png", domain: cfg.pagesDomain });
    const agentKey = agentPlaceholder(root).toBase58();
    let sim;
    try {
      const shares = splitShares({ creator: agentKey, parentCreator: coin.creator, grandparentCreator: null, platform: cfg.platformWallet, bps: cfg.splitBps });
      sim = await this.simulate({ rpc: this.rpc, root: coin, form: { name: d.best.name, symbol: d.best.symbol, uri: meta.metadataUri }, shares, launchFee: launchFeeOf(cfg.launchFeeSol ?? 0, cfg.platformWallet), seed: id, probe: cfg.probe ?? undefined });
    } catch (e) {
      sim = { ok: false, bytes: null, unitsConsumed: null, estCostSol: null, err: `simulation unavailable: ${String(e.message ?? e).slice(0, 200)}`, agent: agentKey };
    }
    // The CLI writes to the same file: a gated run re-reads the cooldown before storing, so a proposal
    // another process stored while this one was simulating is not doubled.
    const latest = this.registry.lastProposalAt(root);
    if (!force && latest != null && latest !== lastAt && t - latest < cfg.cooldownMin * 60) {
      try { unlinkSync(join(this.imgDir, file)); } catch { /* already gone */ }
      this.registry.recordRun(root, { at: t, nextAt, score: s.score, reason: `${s.reason}; not proposing: another run proposed for this root meanwhile` });
      return { skipped: "another run proposed for this root meanwhile", score: s.score };
    }
    const r = d.best.rubric;
    const reason = `${s.reason}; picked $${d.best.symbol} (${ctx.brief ? `owner's brief (${ctx.brief.mode}), rank fit` : "theme fit"} ${r.fit}, brevity ${r.brevity}, uniqueness ${r.uniqueness}) over ${d.runnersUp.length} runner${d.runnersUp.length === 1 ? "" : "s"}-up${d.filtered.length ? `, ${d.filtered.length} filtered` : ""}${force && !g.ok ? `; run by hand past the gate (${g.why})` : ""}`;
    const row = this.registry.addProposal({
      id, root, createdAt: t, name: d.best.name, symbol: d.best.symbol, description: d.best.description, imageFile: file,
      score: s.score, reason, sim, status: sim.ok ? "proposed" : "rejected", rejectedReason: sim.ok ? null : `simulation failed: ${sim.err}`,
      source: d.source, runnersUp: d.runnersUp, filtered: d.filtered, rubric: r, metadataUri: meta.metadataUri,
      why: d.best.why ?? null, logoSource: this.lastLogoSource ?? null,
    });
    this.registry.recordRun(root, { at: t, nextAt, score: s.score, reason, proposed: true });
    this.stats.proposals++;
    const view = proposalView(row);
    this.lastSeq = Math.max(this.lastSeq, row.seq);
    this.hub?.emit("agent", { root, proposal: view });
    this.log.info?.(`agents: ${ctx.rootSymbol ?? root} proposed $${view.symbol} "${view.name}" (score ${s.score}, ${view.source}; sim ${sim.ok ? `ok ${sim.bytes} B ${sim.unitsConsumed} CU ~${sim.estCostSol} SOL` : `failed: ${sim.err}`})`);
    // `brief` tells the live layer how to describe the coin it launches (a people coin carries the tribute line).
    return { proposal: view, score: s.score, brief: ctx.brief ? { mode: ctx.brief.mode } : null };
  }

  snapshot() { return { mode: this.cfg.mode, tickSec: this.cfg.tickSec, ...this.stats, llm: this.llm.snapshot?.() ?? null }; }
}
