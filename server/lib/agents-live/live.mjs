// Live agents (DESIGN §13.1): the dry runner (lib/agents/runner.mjs) stays the idea engine — profile,
// gates, design, simulation, proposal record — and this layer adds what the owner decided a live
// agent is: its own wallet, a starting budget, a model (the owner's keyed provider, booked per
// agent), a logo the model draws, a real launch, fee claims and (on the solana-x402 rail) USDC
// top-ups. One pass per tick, agents in turn, at most one on-chain action per agent per tick,
// everything through the ledger, launches persisted in the registry.
//
// Order of one pass for one agent (review 2026-10-19): finish an owed fee split → claim the ROOT's
// fees (the agent's only SOL income) and its children's → budget → (top-up) → think + launch.
// Claims run before the sleep gate, so a seeded agent keeps earning from its root even while it
// cannot afford a launch. The $5 start gate applies until the agent's first launch; after that only
// the launch gate (cost + margin + reserve) decides.
//
// Nothing here reads outside input: the only signals are the indexer's numbers and the chain.
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { AgentVault, readVaultKey } from "./vault.mjs";
import { readBudget, canStart, canThink, topUpNeeded, BUDGET_DEFAULTS, LAMPORTS_PER_SOL } from "./budget.mjs";
import { createPaidLlm, createPaymentLedger } from "./pay.mjs";
import { bookedLlm, createSpendMeter } from "./keyed.mjs";
import { purposeDescription, agentSiteUrl, DEFAULT_PUBLIC_URL } from "../agents/purpose.mjs";
import { openSync, writeSync, closeSync, readFileSync as readLock, unlinkSync as unlinkLock } from "node:fs";
import { assertModel, DEFAULT_MODEL, modelInfo } from "./models.mjs";
import { drawLogo } from "./ailogo.mjs";
import { launchLive, finishSplit } from "./launch.mjs";
import { claimCoin } from "./claim.mjs";
import { topUpUsdc } from "./swap.mjs";
import { payoutSurplus } from "./payout.mjs";
import { aiDebtOf, payAiFee } from "./aifee.mjs";

/// `aiRail`: "keyed" (owner 2026-10-19: the server calls the model provider with the owner's API key,
/// every call booked against the agent that asked — nothing to pay on-chain for thinking) or
/// "solana-x402" (each agent pays per request from its own USDC through NanoGPT's facilitator, which
/// has refused to settle since 2026-09; kept for when it works again).
/// Cadence (owner 2026-10-19): a tick every minute; fees claimed every tick; a launch every third tick.
export const LIVE_DEFAULTS = Object.freeze({ model: DEFAULT_MODEL, claimEveryTicks: 1, launchEveryTicks: 3, sleepRecheckTicks: 1, failBackoffTicks: 3, maxClaimsPerPass: 1, aiRail: "keyed", llmIdStyle: "nanogpt", dailyUsdPerAgent: 2, dailyUsdTotal: 10, payoutAddress: null, aiFeeAddress: null, keepSol: 0.1, minPayoutSol: 0.01, minPayoutUsdc: 0.5, publicUrl: DEFAULT_PUBLIC_URL, ...BUDGET_DEFAULTS });

/**
 * A language-model provider the dry runner can hold as its single `llm` while every call is paid by
 * (or booked to) the agent currently running: `use(root, llm)` before a run, `release()` after.
 */
export function routedLlm() {
  let cur = null;
  const need = () => { if (!cur) throw new Error("no agent is running"); return cur; };
  return {
    get available() { return !!cur?.available; },
    get model() { return cur?.model ?? null; },
    use(root, llm) { cur = llm; cur.root = root; },
    release() { cur = null; },
    chatJson: (m, o) => need().chatJson(m, o),
    chatText: (m, o) => need().chatText(m, o),
    snapshot: () => cur?.snapshot?.() ?? { available: false, model: null },
  };
}

export class LiveAgents {
  /**
   * `runner`: the dry AgentRunner built with `llm: router` (this class sets `runner.render` to the
   * model-drawn logo). `metaHost`: lib/metahost.mjs. `keyedLlm`: the owner's provider for the keyed
   * rail. `cfg`: { dataDir, vaultKeyFile, model, aiRail, platformWallet, splitBps, startUsd, reserveSol,
   * aiFloorUsd, aiTargetUsd, launchMarginSol, claimEveryTicks }. `deps` are seams for tests.
   */
  constructor({ runner, router, registry, model, rpc, metaHost, hub = null, keyedLlm = null, imageGen = null, cfg = {}, log = console, deps = {} }) {
    this.runner = runner; this.router = router; this.registry = registry; this.model = model; this.rpc = rpc; this.metaHost = metaHost; this.hub = hub; this.log = log;
    this.keyedLlm = keyedLlm; this.imageGen = imageGen; // the owner's keyed providers (text; images), used when cfg.aiRail === "keyed"
    this.cfg = { ...LIVE_DEFAULTS, ...Object.fromEntries(Object.entries(cfg).filter(([, v]) => v != null)) };
    assertModel(this.cfg.model);
    this.deps = { readBudget, launchLive, finishSplit, claimCoin, topUpUsdc, drawLogo, createPaidLlm, payoutSurplus, payAiFee, aiDebtOf, ...deps };
    this.vault = deps.vault ?? new AgentVault({ dir: join(this.cfg.dataDir, "agents", "wallets"), vaultKey: readVaultKey(this.cfg.vaultKeyFile) });
    this.ledger = deps.ledger ?? createPaymentLedger(join(this.cfg.dataDir, "agents", "ledger.jsonl"));
    mkdirSync(join(this.cfg.dataDir, "agents"), { recursive: true });
    // One live process per data directory (review 2026-10-19): two processes would spend the same wallets.
    this.unlock = deps.lock === false ? () => {} : takeLock(join(this.cfg.dataDir, "agents", "live.lock"));
    // Daily model spend ceilings on the keyed rail (review 2026-10-19), shared by every agent of this process.
    this.meter = deps.meter ?? createSpendMeter({ dailyUsdPerAgent: this.cfg.dailyUsdPerAgent, dailyUsdTotal: this.cfg.dailyUsdTotal });
    this.ticks = 0; this.busy = false;
    this.stats = { ticks: 0, asleep: 0, launches: 0, claims: 0, splits: 0, topUps: 0, payouts: 0, aiFees: 0, aiFeesUsd: 0, failures: 0, lastError: null, spentUsd: 0 };
    this.state = new Map(); // root → { address, budget, sleeping, reason, launched: [{mint, at}], lastRunAt, failStreak, sleepTicks, claimCursor }
    runner.render = (opts) => this.#render(opts);
  }

  /** The agent's wallet address (creates the wallet on first sight so the owner can fund it). */
  address(root) { return this.vault.has(root) ? this.vault.address(root) : this.vault.create(root).address; }

  /** Where this agent's surplus goes: the root's creator, unless the root is the owner's own (launched from the platform wallet) or no creator is on file — then the owner's payout address. */
  payoutTargetOf(root) {
    const creator = this.vault.creatorOf?.(root) ?? null;
    if (creator && creator !== this.cfg.platformWallet) return creator;
    return this.cfg.payoutAddress ?? null;
  }

  /** The model this root's creator picked at launch (registry), else the server default. */
  modelFor(root) {
    const picked = this.registry.modelOf?.(root);
    return modelInfo(picked) ? picked : this.cfg.model;
  }

  #stateOf(root, address) {
    let st = this.state.get(root);
    if (!st) {
      // Launched coins come back from the registry after a restart so their fees keep being claimed;
      // coins the index knows as this agent's (its wallet in their split, under this root) that the
      // registry missed (launched before the table existed, or a crash between send and record) are
      // adopted and persisted too.
      const known = new Map((this.registry.launchesOf?.(root) ?? []).map((l) => [l.mint, { mint: l.mint, at: l.created_at, proposal: l.proposal_id, splitDone: !!l.split_done }]));
      for (const c of this.model.coins?.values?.() ?? []) {
        // A child's `quoteMint` is its parent (lib/model.mjs); a root quoted in SOL has none.
        if (c?.quoteMint !== root || !(c.depth > 0) || known.has(c.mint) || !c.shares?.some((s) => s.address === address && s.bps === this.cfg.splitBps?.[0])) continue;
        this.registry.markLaunched?.(root, { mint: c.mint, splitDone: true, at: c.createdAt ?? now() });
        known.set(c.mint, { mint: c.mint, at: c.createdAt ?? now(), proposal: null, splitDone: true });
        this.log.info?.(`agents: ${root} adopted ${c.mint} as its agent's coin (from the index)`);
      }
      st = { address, launched: [...known.values()], failStreak: 0, sleepTicks: 0, claimCursor: 0 };
      this.state.set(root, st);
    }
    return st;
  }

  #llmFor(root, signer, budget) {
    const info = modelInfo(this.modelFor(root));
    if (this.cfg.aiRail === "keyed") return this.keyedLlm?.available ? bookedLlm({ llm: this.keyedLlm, root, model: info.id, ledger: this.ledger, meter: this.meter, idStyle: this.cfg.llmIdStyle, log: this.log }) : null;
    return this.deps.createPaidLlm({ signer, rpc: this.rpc, model: info.id, ledger: this.ledger, root, pocket: async () => (budget.readAt && Date.now() / 1000 - budget.readAt < 30 ? budget.usdc : (await this.deps.readBudget(this.rpc, signer.address, { solUsd: this.model.solUsd })).usdc), log: this.log });
  }

  /** The runner's logo seam: the image model draws it (booked to the root), else the language model's SVG, else the template. */
  async #render(opts) {
    const cur = this.current;
    let image = null;
    if (this.imageGen?.available && cur?.root) {
      const why = this.meter?.refusal(cur.root, this.imageGen.costUsd);
      if (why) this.log.warn?.(`agents: no image logo for ${cur.root}: ${why}`);
      else image = { available: true, generate: async (prompt) => { const png = await this.imageGen.generate(prompt); this.meter?.add(cur.root, this.imageGen.costUsd); this.ledger?.record({ kind: "ai", rail: "keyed", root: cur.root, provider: this.imageGen.model, status: "done", image: true, estUsd: this.imageGen.costUsd }); return png; } };
    }
    // `mode` "people" (an owner's people brief): the image model draws a caricature of the person; if it refuses, the SVG path runs as for any coin.
    const r = await this.deps.drawLogo({ name: opts.name ?? opts.symbol, symbol: opts.symbol, description: opts.description ?? "", ...(opts.mode ? { mode: opts.mode } : {}) }, cur?.profile ?? { palette: opts.palette }, { llm: this.router, image, seed: opts.seed, log: this.log });
    if (cur) cur.logoSource = r.source;
    this.runner.lastLogoSource = r.source;
    return r.png;
  }

  /** One pass over every enabled agent. */
  async tick() {
    if (this.busy) return; this.busy = true; this.ticks++; this.stats.ticks++;
    try {
      for (const row of this.registry.list()) {
        if (row.status !== "dry" && row.status !== "live") continue;
        try { await this.runOne(row.root_mint); }
        catch (e) { this.stats.failures++; this.stats.lastError = `${row.root_mint}: ${String(e.message ?? e).slice(0, 200)}`; this.log.warn?.(`agents: live ${this.stats.lastError}`); }
      }
    } finally { this.busy = false; }
  }

  /** A claim can be paid when the wallet keeps its reserve plus one fee afterwards. */
  #canPayFee(budget) { return budget.lamports >= Math.ceil(this.cfg.reserveSol * LAMPORTS_PER_SOL) + 10_000; }

  /** One agent, one pass: split owed → claims → budget → (top-up) → think + launch. */
  async runOne(root) {
    const address = this.address(root);
    const st = this.#stateOf(root, address);
    const signer = this.vault.signer(root);
    const t = now();
    // Sleeping agents are re-read every few ticks (two RPC calls each), not every tick.
    if (st.sleeping && st.sleepTicks++ % this.cfg.sleepRecheckTicks !== 0) return { asleep: st.reason, skipped: "backoff" };
    let budget = await this.deps.readBudget(this.rpc, address, { solUsd: this.model.solUsd });
    st.budget = budget;
    const feeOk = this.#canPayFee(budget);
    // 0. A coin whose fee split is still owed (its second transaction failed) gets it before anything else.
    const owed = (this.registry.unsplitOf?.(root) ?? [])[0];
    if (owed && feeOk) {
      const r = await this.deps.finishSplit({ rpc: this.rpc, signer, root: this.model.get(root), mint: owed.mint, cfg: { platformWallet: this.cfg.platformWallet, splitBps: this.cfg.splitBps }, ledger: this.ledger, log: this.log });
      this.registry.markSplit?.(owed.mint, r.signature);
      const l = st.launched.find((x) => x.mint === owed.mint); if (l) l.splitDone = true;
      this.stats.splits++;
      return { split: r };
    }
    // 1. Fees: the root first (SOL, the agent's income), then its children, one claim per pass. A
    //    claim does not end the pass (an active root would otherwise starve launches): the budget is
    //    re-read and the pass goes on.
    let claimed = null;
    if (feeOk && this.ticks % this.cfg.claimEveryTicks === 0) {
      const targets = [root, ...st.launched.map((c) => c.mint)];
      for (let i = 0; i < targets.length; i++) {
        const mint = targets[(st.claimCursor + i) % targets.length];
        const r = await this.deps.claimCoin({ rpc: this.rpc, signer, mint, ledger: this.ledger, root, model: this.model, log: this.log });
        if (r) { st.claimCursor = (st.claimCursor + i + 1) % targets.length; this.registry.markClaimed?.(mint, t); this.stats.claims++; claimed = { mint, ...r }; break; }
      }
      if (!claimed) st.claimCursor = 0;
      if (claimed) { budget = await this.deps.readBudget(this.rpc, address, { solUsd: this.model.solUsd }); st.budget = budget; }
    }
    // 1a. The agent pays for its thinking (keyed rail): what the ledger books as model cost since the
    //     last payment goes to the owner in SOL, before any new spending. Partial when the wallet is
    //     short; the rest stays owed and is visible on the agent page.
    const feeTo = this.cfg.aiFeeAddress ?? this.cfg.payoutAddress;
    if (this.cfg.aiRail === "keyed" && feeTo && feeOk) {
      const debt = this.deps.aiDebtOf(this.ledger?.file, root);
      st.owedUsd = debt.owedUsd;
      if (debt.owedUsd > 0 && this.model.solUsd > 0) {
        const r = await this.deps.payAiFee({ rpc: this.rpc, signer, budget, to: feeTo, owedUsd: debt.owedUsd, solUsd: this.model.solUsd, reserveSol: this.cfg.reserveSol, ledger: this.ledger, root, log: this.log });
        if (r) { this.stats.aiFees++; this.stats.aiFeesUsd += r.usd; st.owedUsd = Math.max(0, debt.owedUsd - r.usd); budget = await this.deps.readBudget(this.rpc, address, { solUsd: this.model.solUsd }); st.budget = budget; }
      }
    }
    // 1b. Surplus to the owner (owner 2026-10-19: automatic): whatever exceeds the working balance
    //     (keepSol + reserve), and idle USDC on the keyed rail, goes to the payout address — one
    //     transaction per pass, before anything is spent on new launches.
    //     The surplus belongs to whoever launched the root: the creator recorded when the wallet was
    //     prepared. A root launched by the platform wallet (the owner's own) pays the owner's payout
    //     address; a seeded agent with no creator on file does the same. The AI fee (step 1a) always
    //     goes to the owner, whose provider account paid for the thinking.
    const payoutTo = this.payoutTargetOf(root);
    if (payoutTo && feeOk) {
      const r = await this.deps.payoutSurplus({ rpc: this.rpc, signer, budget, to: payoutTo, cfg: { keepSol: this.cfg.keepSol, reserveSol: this.cfg.reserveSol, minPayoutSol: this.cfg.minPayoutSol, minPayoutUsdc: this.cfg.minPayoutUsdc, sweepUsdc: this.cfg.aiRail === "keyed" }, ledger: this.ledger, root, log: this.log });
      if (r) { this.stats.payouts++; return { payout: r }; }
    }
    // 2. Budget: $5 to start; after the first launch only the launch gate decides (launchLive).
    const started = st.launched.length > 0 || (this.registry.launchCount?.(root) ?? 0) > 0;
    const start = started ? { ok: feeOk, reason: feeOk ? "running" : "wallet under the reserve" } : canStart(budget, this.cfg);
    if (!start.ok) { st.sleeping = true; st.reason = start.reason; this.stats.asleep++; this.registry.recordRun?.(root, { at: t, nextAt: t + 300, reason: `asleep: ${start.reason}` }); return { asleep: start.reason }; }
    st.sleeping = false; st.sleepTicks = 0; st.reason = start.reason;
    // A launch that failed last pass waits a few passes before paying for ideas again.
    if (st.failStreak > 0 && (this.ticks - (st.lastFailTick ?? 0)) < Math.min(this.cfg.failBackoffTicks * st.failStreak, 24)) return { skipped: `backoff after ${st.failStreak} failed launch${st.failStreak === 1 ? "" : "es"}` };
    // 3. The USDC pocket (solana-x402 rail only): without it the agent cannot think.
    const need = this.cfg.aiRail === "keyed" ? { needed: false, usd: 0 } : topUpNeeded(budget, this.cfg);
    if (need.needed) {
      const r = await this.deps.topUpUsdc({ rpc: this.rpc, signer, budget, usd: need.usd, reserveSol: this.cfg.reserveSol, ledger: this.ledger, root, log: this.log });
      this.stats.topUps++;
      return { topUp: r };
    }
    // 4. Think (booked or paid) and, when the proposal simulates, launch — but never pay for an idea
    //    the wallet cannot launch: the last real launch cost (or a 0.016 SOL prior) plus margin and
    //    reserve must be there first.
    if (this.ticks % this.cfg.launchEveryTicks !== 0) return { skipped: `launches every ${this.cfg.launchEveryTicks} ticks` };
    const minLaunchSol = (this.lastCostSol ?? 0.016) + this.cfg.launchMarginSol + this.cfg.reserveSol;
    if (budget.sol < minLaunchSol) { st.reason = `waiting for funds: ${budget.sol.toFixed(4)} SOL, a launch needs ${minLaunchSol.toFixed(4)}`; return { skipped: st.reason }; }
    const cap = modelInfo(this.modelFor(root)).capUsd;
    const think = this.cfg.aiRail === "keyed" ? { ok: true, reason: "keyed provider" } : canThink(budget, cap);
    const llm = think.ok ? this.#llmFor(root, signer, budget) : null;
    this.current = { root, profile: this.registry.profileOf?.(root) ?? null, name: null, logoSource: null };
    if (llm) this.router.use(root, llm); else this.router.release();
    let run;
    try { run = await this.runner.runAgent(root); }
    finally { this.router.release(); const s = llm?.snapshot?.(); if (s) this.stats.spentUsd += s.paidUsd ?? 0; this.current = null; }
    st.lastRunAt = t;
    if (!run?.proposal) return run;
    const p = run.proposal;
    if (!p.sim?.ok) return { proposal: p, skipped: "simulation failed" };
    const png = readFileSync(join(this.runner.imgDir, `${p.id}.png`));
    const coin = this.model.get(root);
    const fresh = await this.deps.readBudget(this.rpc, address, { solUsd: this.model.solUsd });
    let r;
    try {
      const rootSymbol = this.model.nameOf?.(root)?.symbol ?? coin.symbol ?? null; // names live in the metadata store, not on the coin record
      const tribute = run.brief?.mode === "people" ? p.name : null; // a coin named after a real person says it is a fan tribute
      r = await this.deps.launchLive({ rpc: this.rpc, signer, root: coin, form: { name: p.name, symbol: p.symbol, description: purposeDescription(p, rootSymbol, { tribute }), website: agentSiteUrl(root, this.cfg.publicUrl), proposalId: p.id }, imageBytes: png, metaHost: this.metaHost, budget: fresh, cfg: { platformWallet: this.cfg.platformWallet, splitBps: this.cfg.splitBps, budget: this.cfg }, ledger: this.ledger, registry: this.registry, log: this.log });
    } catch (e) {
      st.failStreak++; st.lastFailTick = this.ticks;
      throw e;
    }
    st.failStreak = 0;
    if (r.estCostSol > 0) this.lastCostSol = r.estCostSol;
    st.launched.push({ mint: r.mint, at: t, proposal: p.id, splitDone: r.splitDone });
    this.stats.launches++;
    this.hub?.emit("agent", { root, proposal: { ...p, launched: { mint: r.mint, signature: r.signatures[0] } } });
    return { proposal: p, launched: r };
  }

  /** Releases the process lock (call on shutdown). */
  stop() { try { this.unlock?.(); } catch { /* best effort */ } }

  snapshot() {
    return { mode: "live", rail: this.cfg.aiRail, model: this.cfg.model, ...this.stats, spend: this.meter?.snapshot?.() ?? null, keyed: this.keyedLlm?.snapshot?.() ?? null, image: this.imageGen?.snapshot?.() ?? null, agents: [...this.state].map(([root, s]) => ({ root, address: s.address, sleeping: !!s.sleeping, reason: s.reason ?? null, sol: s.budget?.sol ?? null, usdc: s.budget?.usdc ?? null, usd: s.budget?.usd ?? null, launched: s.launched.length, failStreak: s.failStreak, owedUsd: s.owedUsd ?? null })) };
  }
}

const now = () => Math.floor(Date.now() / 1000);

/**
 * An exclusive lock file holding this process id. A stale lock (its process gone) is taken over;
 * a live one makes construction fail loudly. Returns the release function.
 */
export function takeLock(file) {
  const claim = () => { const fd = openSync(file, "wx"); try { writeSync(fd, `${process.pid}\n`); } finally { closeSync(fd); } };
  try { claim(); }
  catch (e) {
    if (e.code !== "EEXIST") throw e;
    let pid = NaN; try { pid = Number(readLock(file, "utf8").trim()); } catch { /* unreadable */ }
    let alive = false;
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) { try { process.kill(pid, 0); alive = true; } catch (err) { alive = err.code === "EPERM"; } }
    if (alive) throw new Error(`another live agents process (pid ${pid}) holds ${file}`);
    try { unlinkLock(file); } catch { /* raced */ }
    claim();
  }
  return () => { try { if (Number(readLock(file, "utf8").trim()) === process.pid) unlinkLock(file); } catch { /* gone */ } };
}
