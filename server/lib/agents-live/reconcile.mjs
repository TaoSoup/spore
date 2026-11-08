// Binding agent wallets from the chain (DESIGN §13.1). A root launch puts a prepared wallet's address
// into the coin's fee split before anyone reports the launch; the browser's report can be lost, so
// the chain is the source of truth: whenever an indexed coin's sharing config names a pending
// wallet's address at the agent's share, that wallet is bound to the coin and its agent enabled.
// Runs on a timer in every mode (the vault exists wherever root launches do) and is idempotent.
import { ROOT_SPLIT_BPS } from "../pricing.mjs";
import { modelInfo, DEFAULT_MODEL } from "./models.mjs";

/** Coins whose shares name `address` with the agent's bps (any depth; a root is depth 0). */
export function coinsNaming(model, address, { bps = ROOT_SPLIT_BPS.agent } = {}) {
  const out = [];
  for (const c of model.coins?.values?.() ?? []) {
    if (c?.shares?.some((s) => s.address === address && s.bps === bps)) out.push(c);
  }
  return out;
}

/**
 * One pass: every pending wallet named by exactly one indexed coin is bound to it. Returns the
 * bindings made. Never throws for one wallet's failure; `log` gets a line per bind.
 */
export function reconcilePendingWallets({ vault, model, registry, log = console, now = () => Math.floor(Date.now() / 1000) }) {
  const made = [];
  let list;
  try { list = vault.pendingList(); } catch (e) { log.warn?.(`agents: reconcile: cannot list pending wallets: ${e.message}`); return made; }
  for (const p of list) {
    try {
      const coins = coinsNaming(model, p.address);
      if (coins.length !== 1) continue; // none yet, or ambiguous (never bind on a guess)
      const coin = coins[0];
      if (vault.has(coin.mint)) continue; // already has a wallet (bound earlier, or seeded)
      const b = vault.bind(p.id, coin.mint);
      const mdl = modelInfo(p.model) ? p.model : DEFAULT_MODEL;
      registry.enable(coin.mint, { model: mdl, wallet: b.address });
      made.push({ root: coin.mint, address: b.address, model: mdl, at: now() });
      log.info?.(`agents: ${coin.mint} agent wallet ${b.address} bound from the chain (model ${mdl})`);
    } catch (e) { log.warn?.(`agents: reconcile ${p.id}: ${String(e.message ?? e).slice(0, 160)}`); }
  }
  return made;
}

/** Starts the periodic reconciler; returns a stop function. */
export function startReconciler(deps, { everyMs = 60_000 } = {}) {
  const run = () => { try { reconcilePendingWallets(deps); } catch (e) { deps.log?.warn?.(`agents: reconcile pass failed: ${e?.message ?? e}`); } try { deps.vault.sweepPending(); } catch { /* best effort */ } };
  const t = setInterval(run, everyMs); t.unref?.();
  const first = setTimeout(run, 15_000); first.unref?.();
  return () => { clearInterval(t); clearTimeout(first); };
}
