// Pure pricing and fee-split math (DESIGN §4, §6.4). No I/O, no model access: inputs are plain
// numbers/strings so every branch is covered by the unit tests.

export const LAMPORTS = 1e9;
export const units = (raw, decimals) => Number(BigInt(raw ?? 0)) / 10 ** decimals;

/**
 * Quote per 1 base token from a bonding curve: `virtualQuoteReserves / virtualTokenReserves`,
 * each side scaled by its decimals. Null when the curve has no virtual reserves (migrated).
 */
export function curvePriceQuote(c, baseDecimals, quoteDecimals) {
  const vt = Number(BigInt(c.virtualTokenReserves ?? 0));
  if (!(vt > 0)) return null;
  const vq = Number(BigInt(c.virtualQuoteReserves ?? 0));
  return (vq / 10 ** quoteDecimals) / (vt / 10 ** baseDecimals);
}

/** A signed integer string (an i128 such as a pool's virtual quote reserves) as a BigInt; null, empty or malformed = 0. */
const bigOr0 = (v) => { if (v == null || v === "") return 0n; try { return BigInt(v); } catch { return 0n; } };

/**
 * Quote per 1 base token from a PumpSwap pool: (quote vault + the pool's signed `virtual_quote_reserves`)
 * / base vault, decimal-scaled. pump-amm prices a pool on that effective quote side (the SDK's
 * chainCoinHop adds the same term), so a pool seeded with virtual quote is worth more than its vault
 * alone. The sum is taken in BigInt and turned into a Number only for the ratio; a null or absent
 * virtual quote counts as 0; an effective quote side <= 0 or an empty base vault has no price.
 * Locked value and the LIQ_X liquidity cap keep reading the real vault (liqQuoteOf, model.computed()).
 */
export function poolPriceQuote(poolQuote, poolBase, baseDecimals, quoteDecimals, virtualQuote = null) {
  if (poolQuote == null || poolBase == null) return null;
  const base = Number(BigInt(poolBase));
  if (!(base > 0)) return null;
  const eff = BigInt(poolQuote) + bigOr0(virtualQuote);
  if (eff <= 0n) return null;
  return (Number(eff) / 10 ** quoteDecimals) / (base / 10 ** baseDecimals);
}

/** The price source `create_v2` itself uses: the pool once migrated, the curve before. */
export function priceQuoteOf(c, baseDecimals, quoteDecimals) {
  return c.migrated ? poolPriceQuote(c.poolQuote, c.poolBase, baseDecimals, quoteDecimals, c.poolVirtualQuote) : curvePriceQuote(c, baseDecimals, quoteDecimals);
}

/** Curve progress 0..1 = share of the initial real token reserves sold; 1 once complete. */
export function progressOf(c, initialRealTokenReserves) {
  if (c.complete || c.migrated) return 1;
  const initial = Number(BigInt(initialRealTokenReserves ?? 0));
  if (!(initial > 0)) return 0;
  const left = Number(BigInt(c.realTokenReserves ?? 0));
  return Math.max(0, Math.min(1, 1 - left / initial));
}

/**
 * Walks a chain (self first, down to the depth-0 root) multiplying `priceQuote` at each step.
 * `rootQuote` is the root's quote kind: `"sol"`, `"usdc"` or `"other"` (a quote-control mint such
 * as PUMP or a tokenized stock). Returns prices in SOL and USD, null where they cannot be derived.
 * A USDC root uses 1 USD = 1 USDC; an "other" root is priced only when its quote's USD price
 * (`otherUsd`) is known; SOL and USD convert through `solUsd`.
 */
export function chainPrices(chain, rootQuote, solUsd, otherUsd = null) {
  let product = 1;
  for (const step of chain) {
    if (step == null || !(step > 0)) return { priceSol: null, priceUsd: null };
    product *= step;
  }
  if (rootQuote === "sol") return { priceSol: product, priceUsd: solUsd ? product * solUsd : null };
  if (rootQuote === "usdc") return { priceSol: solUsd ? product / solUsd : null, priceUsd: product };
  if (otherUsd > 0) return { priceSol: solUsd ? (product * otherUsd) / solUsd : null, priceUsd: product * otherUsd };
  return { priceSol: null, priceUsd: null };
}

/**
 * Liquidity cap for sizing by market cap (owner 2026-10-21, "size by mcap"): a coin's mcap counts on
 * the map for at most LIQ_X times the quote liquidity behind its price (the pool's quote vault once
 * migrated, the curve's virtual quote reserves before), so a 1e9-supply coin with a dollar of
 * liquidity cannot draw as a billion-dollar family.
 */
export const LIQ_X = 50;

/** The capped mcap (LIQ_X x liqUsd, cents) when mcapUsd exceeds it; null when uncapped or unknown. */
export function mcapCapOf(mcapUsd, liqUsd, x = LIQ_X) {
  if (!(mcapUsd > 0) || liqUsd == null || !Number.isFinite(liqUsd) || liqUsd < 0) return null;
  const cap = x * liqUsd;
  return mcapUsd > cap ? Math.round(cap * 100) / 100 : null;
}

/** Quote units behind a coin's price: the pool's quote vault once migrated, the curve's virtual quote reserves before. */
export function liqQuoteOf(c, quoteDecimals) {
  const raw = c.migrated ? c.poolQuote : c.virtualQuoteReserves;
  if (raw == null || quoteDecimals == null) return null;
  return units(raw, quoteDecimals);
}

export const DEFAULT_SPLIT_BPS = [5000, 0, 0, 5000]; // creator / parent / grandparent / platform — two shareholders by default

/**
 * A ROOT coin's split (owner 2026-10-19, DESIGN §13.1): pump's creator fee (0.95 % of volume on the
 * AMM, 0.30 % on the curve) goes creator 0.25 % / platform 0.50 % / the root's agent wallet 0.20 %,
 * i.e. these bps of whatever accrues. The web pins the same numbers (web/src/lib/policy.ts).
 */
export const ROOT_SPLIT_BPS = Object.freeze({ creator: 2632, platform: 5263, agent: 2105 });

/** The three shareholders of a root launch; `agent` null = the preview before a wallet was prepared. */
export function rootShares({ creator, platform, agent = null }) {
  if (agent) {
    const shares = mergeShares([{ address: creator ?? "", bps: ROOT_SPLIT_BPS.creator }, { address: platform, bps: ROOT_SPLIT_BPS.platform }, { address: agent, bps: ROOT_SPLIT_BPS.agent }]);
    if (shares.length !== 3) throw new Error("root split: creator, platform and agent must be three different wallets");
    return shares;
  }
  // The preview before a wallet exists: the agent's slice is stated separately (API `agent.bps`),
  // so these two do not sum to 10000 on purpose. The platform launching its own root merges.
  if (creator && creator === platform) return [{ address: platform, bps: ROOT_SPLIT_BPS.creator + ROOT_SPLIT_BPS.platform }];
  return [{ address: creator ?? "", bps: ROOT_SPLIT_BPS.creator }, { address: platform, bps: ROOT_SPLIT_BPS.platform }];
}

export function parseSplitBps(s) {
  const parts = String(s ?? "").split(",").map((x) => Number(x.trim()));
  if (parts.length !== 4 || parts.some((x) => !Number.isInteger(x) || x < 0) || parts.reduce((a, b) => a + b, 0) !== 10_000) {
    throw new Error(`SPLIT_BPS must be four integers summing to 10000, got "${s}"`);
  }
  return parts;
}

/**
 * Sums duplicate addresses, drops zero shares and checks the total: pump-fees rejects duplicates,
 * zero shares and any sum but 10 000, so a self-spawn (child creator = parent creator) or a
 * platform-owned parent must be merged before `update_fee_shares_v2` is built.
 */
export function mergeShares(entries) {
  const byAddress = new Map();
  for (const { address, bps } of entries) {
    if (!Number.isInteger(bps) || bps < 0) throw new Error(`invalid share ${bps} for ${address}`);
    if (bps === 0) continue;
    byAddress.set(address, (byAddress.get(address) ?? 0) + bps);
  }
  const shares = [...byAddress].map(([address, bps]) => ({ address, bps }));
  const total = shares.reduce((a, s) => a + s.bps, 0);
  if (total !== 10_000) throw new Error(`shares sum to ${total}, expected 10000`);
  if (shares.length > 10) throw new Error(`${shares.length} shareholders, pump-fees allows at most 10`);
  return shares;
}

/**
 * The fee split for a coin spawned under `parentCreator` (DESIGN §4): child creator, parent creator,
 * grandparent creator (its slice folds into the parent creator when there is none), platform.
 * `creator` may be null while no wallet is connected: the child slot then carries an empty address
 * so the UI can label it "you" and the other slots still merge correctly.
 */
export function splitShares({ creator, parentCreator, grandparentCreator, platform, bps = DEFAULT_SPLIT_BPS }) {
  const [child, parent, grand, plat] = bps;
  const entries = [
    { address: creator ?? "", bps: child },
    { address: parentCreator, bps: grandparentCreator ? parent : parent + grand },
    ...(grandparentCreator ? [{ address: grandparentCreator, bps: grand }] : []),
    { address: platform, bps: plat },
  ];
  return mergeShares(entries);
}

export const DEFAULT_LAUNCH_FEE_SOL = 0; // owner decision 2026-10-19: launching costs only network fees; Spore earns through the creator-fee share

/**
 * The launch fee the Spawn page adds as a SystemProgram transfer to the platform (DESIGN §11.2).
 * Lamports travel as a decimal string so the browser can hand them to BN/BigInt without a float
 * round-trip; a fee of 0 is a valid "no fee" (the UI hides the line).
 */
export function launchFeeOf(sol, to) {
  const n = Number(sol);
  if (!Number.isFinite(n) || n < 0 || n > 10) throw new Error(`LAUNCH_FEE_SOL must be between 0 and 10, got "${sol}"`);
  const lamports = BigInt(Math.round(n * LAMPORTS));
  return { to, lamports: lamports.toString(), sol: Number(lamports) / LAMPORTS };
}
