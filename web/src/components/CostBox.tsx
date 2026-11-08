import type { ReactNode } from "react";
import { lamportsToSol, sol, usd } from "../lib/format";
import "./launch.css";

// Rent the launch transaction pays on top of the launch fee: mint + bonding curve + fee-sharing
// config + the curve's quote vault ATA, roughly 0.025 SOL on mainnet (DESIGN §11.2, lib/copy.ts
// NETWORK_RENT_SOL). An estimate, so the box says "~" until the pre-flight simulation measured it,
// and the balance check keeps a small margin for network fees.
export const EST_RENT_LAMPORTS = 25_000_000n;
export const FEE_MARGIN_LAMPORTS = 1_000_000n;
/// Older callers: launch fee + estimated rent + first buy (no agent gas).
export const spawnTotal = (feeLamports: bigint, buyLamports: bigint) => feeLamports + EST_RENT_LAMPORTS + buyLamports;
/// What one launch takes from the wallet: launch fee + rent (estimated, or the simulated figure) +
/// a root's agent gas (lib/policy.ts AGENT_SEED_LAMPORTS, same signature) + the optional first buy.
/// The box's Total and the launch button's balance check both use this, so they always agree.
export const launchTotal = (feeLamports: bigint, buyLamports: bigint, seedLamports: bigint = 0n, rentLamports: bigint = EST_RENT_LAMPORTS) => feeLamports + rentLamports + seedLamports + buyLamports;
/// The simulated create spends rent + network fees + launch fee + agent gas in one signature; the
/// rent-and-fees part is what is left after the two fixed transfers.
export const simulatedRent = (spent: bigint | null | undefined, feeLamports: bigint, seedLamports: bigint): bigint | null => {
  if (spent === null || spent === undefined) return null;
  const r = spent - feeLamports - seedLamports;
  return r > 0n ? r : null;
};

export type BuyEstimate = { tokens: bigint | null; symbol: string; loading: boolean; error: string | null; hops: number };

type Props = {
  feeLamports: bigint; buyLamports: bigint; connected: boolean; balance: bigint | null; balanceError: string | null; solUsd: number | null; estimate?: BuyEstimate | null;
  /// A root's agent gas (0 for a child).
  seedLamports?: bigint;
  /// Rent + network fees as the pre-flight simulation measured them (replaces the estimate).
  simulatedRentLamports?: bigint | null;
};

/// What the signature spends, line by line, against the wallet balance: launch fee (only when the
/// server charges one), network rent, a root's agent gas, the optional first buy, and the total.
/// With a first buy the row also says what that buy would return (pump's curve math on the new curve).
export default function CostBox({ feeLamports, buyLamports, connected, balance, balanceError, solUsd, estimate, seedLamports = 0n, simulatedRentLamports = null }: Props) {
  const rent = simulatedRentLamports ?? EST_RENT_LAMPORTS;
  const total = launchTotal(feeLamports, buyLamports, seedLamports, rent);
  const insufficient = balance !== null && balance < total + FEE_MARGIN_LAMPORTS;
  const inUsd = (lamports: bigint) => (solUsd ? usd(lamportsToSol(lamports) * solUsd) : null);
  const Row = ({ label, note, value, total: isTotal = false, approx = false, tone = "" }: { label: string; note?: ReactNode; value: bigint; total?: boolean; approx?: boolean; tone?: string }) => (
    <><dt className={`${isTotal ? "total" : ""} ${tone}`}><span className="led-k">{label}</span>{note && <small>{note}</small>}</dt><dd className={`mono ${isTotal ? "total" : ""} ${tone}`}>{isTotal ? "≈ " : approx ? "~" : ""}{sol(lamportsToSol(value))}{inUsd(value) && <small>{inUsd(value)}</small>}</dd></>
  );
  const est = estimate && buyLamports > 0n ? estimate : null;
  const estText = est ? (est.loading ? "quoting…" : est.error ? est.error : est.tokens !== null ? `≈ ${(Number(est.tokens) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 0 })} $${est.symbol || "TOKENS"}${est.hops > 1 ? ` through ${est.hops} hops` : ""}` : null) : null;
  return (
    <div className={`cost v2 cost-ledger ${insufficient ? "short" : ""}`} aria-label="Cost">
      <div className="cost-head">
        <span className="label cost-title">What it costs</span>
        {feeLamports === 0n && <span className="chip accent cost-free">No launch fee</span>}
        <span className="cost-wallet">
          {!connected ? <span className="muted">connect a wallet to check your balance</span>
            : balance === null ? <span className="muted">{balanceError ? "balance unavailable" : "reading your balance…"}</span>
            : <span className={`mono ${insufficient ? "bad" : "muted"}`}>wallet {sol(lamportsToSol(balance))}</span>}
        </span>
      </div>
      <dl className="cost-rows">
        {feeLamports > 0n && <Row label="Launch fee" note="to Spore, inside the launch transaction" value={feeLamports} />}
        {simulatedRentLamports !== null
          ? <Row label="Network rent + fees · simulated" note="measured on a copy of the chain before you sign" value={simulatedRentLamports} />
          : <Row label="Network rent" note="mint · curve · fee config · vault, estimated" value={EST_RENT_LAMPORTS} approx />}
        {seedLamports > 0n && <Row label="Agent's starting gas" note="to your coin's agent wallet, same signature" value={seedLamports} tone="agent" />}
        {buyLamports > 0n && <Row label="First buy" note={<>second signature, optional{estText && <> · <span className={est?.error ? "bad" : "accent"}>{estText}</span></>}</>} value={buyLamports} />}
        <Row label="Total" value={total} total />
      </dl>
      {insufficient && balance !== null && <div className="notice bad compact"><span><b>Not enough SOL.</b> This needs about {sol(lamportsToSol(total + FEE_MARGIN_LAMPORTS))} including network fees; the wallet holds {sol(lamportsToSol(balance))}, short by {sol(lamportsToSol(total + FEE_MARGIN_LAMPORTS - balance))}. Top up or lower the first buy.</span></div>}
    </div>
  );
}
