import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { api, pumpUrl, solscanTx, type Coin } from "../lib/api";
import { routeLabels } from "../lib/chain";
import { QUOTE_PROBE, runSwap, withSlippage } from "../lib/flow";
import { isSolRooted, quoteSwap, type Chain, type Side } from "../lib/pump";
import { CU_PRICE_MICRO } from "../lib/pump/trade";
import { useAsync, useDebounced, useLocalPref, useNow } from "../lib/hooks";
import { useDialog } from "../lib/dialog";
import { friendlyError, type Step } from "../lib/steps";
import { amount, exactAmount, feeSol, lamportsToSol, parseAmount, pct, signedPct, sol, tokens, usd } from "../lib/format";
import { ErrorBox, Ext, Logo, Skeleton, sym } from "./Bits";
import Steps from "./Steps";
import Term from "./Term";
import { useToast } from "./Toast";
import SlidingPill from "./ui/SlidingPill";
import { RouteFilament, Tween, type Hop } from "./coin/viz";
import "./coin.css";
import "./coin/terminal.css";

const SLIPPAGES = [50, 100, 300, 500];
const QUICK_SOL = ["0.1", "0.25", "0.5", "1"];
const QUICK_PCT = [25, 50, 75, 100];
/// A quote is re-simulated after this many seconds: pump curves move on every trade and a stale
/// preview is the usual cause of a slippage failure.
const REQUOTE_S = 20;
const STALE_S = 10;
/// Solana's base signature fee and the rent of an associated token account (165 bytes) in
/// lamports; both are protocol constants, shown so the fee line adds up.
const BASE_FEE = 5_000n;
const ATA_RENT = 2_039_280n;
/// Lamports kept back on a buy: the WSOL scratch account's rent is refunded in the same
/// transaction but has to be there at the start.
const HEADROOM = 2_100_000n;

type Route = { chain: Chain; coins: Coin[]; pending: Coin | null };

/// The chain of this coin plus the full record of every ancestor in one pass, so the widget can
/// say *which* coin is awaiting migration instead of waiting for the program's 6107. Same link
/// shape as lib/chain's chainFor (self first, SOL root last); done here to avoid fetching every
/// ancestor twice.
async function loadRoute(coin: Coin): Promise<Route> {
  const ancestors = await Promise.all(coin.ancestors.map((a) => ancestorCached(a.mint)));
  const coins = [coin, ...ancestors];
  const chain: Chain = coins.map((c, i) => ({ mint: c.mint, quoteMint: c.quoteMint, tokenProgram: c.tokenProgram, quoteTokenProgram: coins[i + 1]?.tokenProgram ?? TOKEN_PROGRAM_ID.toBase58(), migrated: c.migrated, depth: c.depth }));
  return { chain, coins, pending: coins.find((c) => c.complete && !c.migrated) ?? null };
}

/// Ancestor records for the route, shared by the desktop widget and every opening of the phone
/// sheet (one request per ancestor a minute, not one per opening). Migration state can change, so
/// the cache is short.
const ancestorCache = new Map<string, { at: number; p: Promise<Coin> }>();
function ancestorCached(mint: string): Promise<Coin> {
  const hit = ancestorCache.get(mint);
  if (hit && Date.now() - hit.at < 60_000) return hit.p;
  const p = api.coin(mint, { children: false, trades: false }).then((r) => r.coin);
  ancestorCache.set(mint, { at: Date.now(), p });
  p.catch(() => { if (ancestorCache.get(mint)?.p === p) ancestorCache.delete(mint); });
  return p;
}

const LockGlyph = () => <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2.5" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>;

type QuoteState = { amountOut: bigint; units: number; at: number; amountIn: bigint; side: Side };

/// "12.50" → "12.5", "3.000000000" → "3": the shortest decimal string for an amount field.
const trimNum = (s: string) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);

/// `amountRef`: the page focuses the amount field through it (the chart's empty state); `titleId`:
/// the id of the sheet head, for the phone dialog's aria-labelledby.
/// `current`: the live record (the coin page's store), read on each render so spot price and the
/// dollar figures follow the market without the widget subscribing to every trade.
export type TradeWidgetProps = { coin: Coin; solUsd: number | null; initialSide?: Side; sheet?: boolean; onClose?: () => void; amountRef?: RefObject<HTMLInputElement | null>; titleId?: string; current?: () => Coin };

/// Buy from SOL / sell to SOL through every hop of the chain in one multi_hop_swap. Quotes come
/// from a simulation (no local curve math), so the preview is what the program does; the widget
/// adds what a terminal needs around it: balances, impact against spot, slippage, fees, the
/// reason a trade is blocked, and a confirm step before the wallet opens.
export default function TradeWidget({ coin: base, solUsd, initialSide = "buy", sheet = false, onClose, amountRef, titleId, current }: TradeWidgetProps) {
  // Identity fields (mint, decimals, ancestors) are the same in both; prices come from the live one.
  const live = current?.();
  const coin = live && live.mint === base.mint ? live : base;
  const { connection } = useConnection();
  const wallet = useWallet();
  const toast = useToast();
  const user = wallet.publicKey;
  const userKey = user?.toBase58() ?? null;
  const route = useAsync(() => loadRoute(coin), [coin.mint]);
  const chain = route.data?.chain ?? null;
  const tradable = chain ? isSolRooted(chain) : null;
  const pending = route.data?.pending ?? null;
  const [side, setSide] = useState<Side>(initialSide);
  const [input, setInput] = useState("");
  const [slippage, setSlippage] = useLocalPref<number>("slippage", 100);
  const [customOpen, setCustomOpen] = useState(() => !SLIPPAGES.includes(slippage));
  const [steps, setSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [bal, setBal] = useState<{ sol: bigint | null; token: bigint | null; hasAta: boolean }>({ sol: null, token: null, hasAta: false });
  const [nonce, setNonce] = useState(0);
  // Buy in dollars: the field takes USD and writes the SOL amount the rest of the widget reads, so the
  // quote, the checks and the transaction never see anything but SOL.
  const [unitPref, setUnitPref] = useLocalPref<string>("trade-unit", "sol");
  const setUsdPref = (on: boolean) => setUnitPref(on ? "usd" : "sol");
  const usdOn = unitPref === "usd" && side === "buy" && !!solUsd && solUsd > 0;
  const [usdText, setUsdText] = useState("");
  const typed = useRef<string | null>(null);
  useEffect(() => {
    if (input === typed.current) return;
    typed.current = null;
    setUsdText(input && solUsd ? trimNum((Number(input.replace(/,/g, "")) * solUsd).toFixed(2)) : "");
  }, [input, solUsd]);
  const onUsd = (v: string) => {
    const clean = v.replace(/[^\d.,]/g, "");
    setUsdText(clean);
    const n = Number(clean.replace(/,/g, ""));
    const s = clean && Number.isFinite(n) && n > 0 && solUsd ? trimNum((n / solUsd).toFixed(9)) : "";
    typed.current = s;
    setInput(s);
  };
  const now = useNow(1_000);
  const dInput = useDebounced(input.trim(), 350);
  const decimalsIn = side === "buy" ? 9 : coin.decimals;
  const amountIn = useMemo(() => parseAmount(dInput, decimalsIn), [dInput, decimalsIn]);
  const ownRef = useRef<HTMLInputElement>(null);
  const inputRef = amountRef ?? ownRef;
  const confirmRef = useDialog<HTMLDivElement>(confirm, () => setConfirm(false));
  // The phone sheet opens on the amount field as soon as the route is known.
  useEffect(() => { if (sheet && route.data) inputRef.current?.focus({ preventScroll: true }); }, [sheet, route.data, inputRef]);
  const refs = useMemo(() => new Map<string, Coin | Coin["ancestors"][number]>([[coin.mint, coin], ...coin.ancestors.map((a) => [a.mint, a] as const)]), [coin]);

  const refreshBalances = useCallback(async () => {
    if (!user) { setBal({ sol: null, token: null, hasAta: false }); return; }
    const ata = getAssociatedTokenAddressSync(new PublicKey(coin.mint), user, false, new PublicKey(coin.tokenProgram));
    const [s, t] = await Promise.all([
      connection.getBalance(user, "confirmed").then((n) => BigInt(n)).catch(() => null),
      // A missing account is the normal "never held it" case, not an error.
      connection.getTokenAccountBalance(ata, "confirmed").then((r) => ({ amount: BigInt(r.value.amount), has: true })).catch(() => ({ amount: 0n, has: false })),
    ]);
    setBal({ sol: s, token: t.amount, hasAta: t.has });
  }, [connection, user, coin.mint, coin.tokenProgram]);
  useEffect(() => { refreshBalances(); const t = setInterval(refreshBalances, 20_000); return () => clearInterval(t); }, [refreshBalances]);

  const [quote, setQuote] = useState<QuoteState | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  useEffect(() => {
    setQuoteErr(null);
    if (!chain || !tradable || !amountIn || pending) { setQuote(null); return; }
    if (side === "sell" && !user) { setQuote(null); setQuoteErr("Connect a wallet to quote a sell"); return; }
    let alive = true;
    setQuoting(true);
    // Before a wallet connects, buys are simulated from a public probe key so the preview works.
    quoteSwap(connection, user ?? QUOTE_PROBE, chain, side, amountIn)
      .then((q) => { if (alive) { setQuote({ amountOut: q.amountOut, units: q.unitsConsumed, at: Date.now(), amountIn, side }); setQuoteErr(null); } })
      .catch((e) => { if (alive) { setQuote(null); setQuoteErr(friendlyError(e)); } })
      .finally(() => { if (alive) setQuoting(false); });
    return () => { alive = false; };
  }, [chain, tradable, pending, amountIn, side, userKey, connection, user, nonce]);

  // Re-simulate a standing quote on a timer, but never under the user's hands (a confirm sheet
  // open, a transaction in flight) and never in a background tab.
  const quoteAge = quote ? Math.max(0, Math.floor((now * 1000 - quote.at) / 1000)) : 0;
  const requote = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    if (!quote || quoting || busy || confirm || document.hidden) return;
    if (quoteAge >= REQUOTE_S) requote();
  }, [quote, quoteAge, quoting, busy, confirm, requote]);

  async function go() {
    if (!chain || !amountIn || !quote) return;
    setConfirm(false); setBusy(true); setSteps([]);
    try {
      const { sig } = await runSwap(connection, wallet, chain, side, amountIn, quote.amountOut, slippage, setSteps);
      toast.success(side === "buy" ? `Bought ${sym(coin)}` : `Sold ${sym(coin)}`, { href: solscanTx(sig), label: "view transaction" });
      setInput(""); setQuote(null); setSteps([]);
      refreshBalances();
      onClose?.();
    } catch (e) { toast.error(friendlyError(e)); }
    finally { setBusy(false); }
  }

  const switchSide = (s: Side) => { if (s === side) return; setSide(s); setInput(""); setQuote(null); setQuoteErr(null); setSteps([]); };
  const pctOf = (p: number) => (bal.token == null ? "" : p === 100 ? exactAmount(bal.token, coin.decimals) : exactAmount((bal.token * BigInt(p)) / 100n, coin.decimals));
  const setPct = (p: number) => { if (bal.token != null) setInput(pctOf(p)); };
  /// "Sell 50%" / "Sell all" under the position: switch to Sell with the amount filled in.
  const sellPct = (p: number) => { if (bal.token == null) return; if (side !== "sell") { setSide("sell"); setQuote(null); setQuoteErr(null); setSteps([]); } setInput(pctOf(p)); inputRef.current?.focus({ preventScroll: true }); };
  const setSlip = (bps: number) => setSlippage(Math.min(5_000, Math.max(1, Math.round(bps))));

  // --- derived figures for the preview ---
  const hops = chain?.length ?? 0;
  // Same CU sizing as buildSwapTx; the unused part of the limit is never charged, but the
  // priority fee is paid on the limit, so this is the real worst case.
  const units = Math.min(1_400_000, 150_000 + 80_000 * hops);
  const networkFee = BASE_FEE + BigInt(Math.ceil((units * CU_PRICE_MICRO) / 1_000_000));
  const ataRent = side === "buy" && user && !bal.hasAta ? ATA_RENT : 0n;
  // What a buy must leave in the wallet besides the amount itself.
  const reserve = networkFee + ataRent + HEADROOM;
  const need = side === "buy" && amountIn ? amountIn + reserve : null;
  const insufficient = amountIn != null && user != null && (side === "buy" ? bal.sol != null && need != null && need > bal.sol : bal.token != null && amountIn > bal.token);
  const outTokens = quote ? tokens(quote.amountOut, coin.decimals) : null;
  const outSol = quote ? lamportsToSol(quote.amountOut) : null;
  const outLabel = quote ? (side === "buy" ? amount(outTokens, sym(coin)) : sol(outSol)) : null;
  const outUsd = quote ? (side === "buy" ? (coin.priceUsd != null ? usd(outTokens! * coin.priceUsd) : null) : (solUsd ? usd(outSol! * solUsd) : null)) : null;
  const minOut = quote ? withSlippage(quote.amountOut, slippage) : null;
  const minLabel = minOut != null ? (side === "buy" ? amount(tokens(minOut, coin.decimals), sym(coin)) : sol(lamportsToSol(minOut))) : null;
  const inSol = amountIn && side === "buy" ? Number(amountIn) / 1e9 : null;
  const inTok = amountIn && side === "sell" ? tokens(amountIn, coin.decimals) : null;
  const inUsd = inSol != null && solUsd ? usd(inSol * solUsd) : inTok != null && coin.priceUsd != null ? usd(inTok * coin.priceUsd) : null;
  // Impact = how far the simulated fill lands from the spot price the page shows. It includes
  // pump's protocol and creator fees (they come out of the same route), which is what the user
  // actually loses versus spot.
  const spot = coin.priceSol;
  const impact = quote && spot && spot > 0 && (inSol != null || inTok != null)
    ? (side === "buy" ? 1 - outTokens! / (inSol! / spot) : 1 - outSol! / (inTok! * spot))
    : null;
  const impactTone = impact == null ? "" : impact > 0.15 ? "bad" : impact > 0.05 ? "warn" : "";
  const effPrice = quote && inSol != null && outTokens ? inSol / outTokens : quote && inTok && outSol != null ? outSol / inTok : null;
  const stale = quote && quoteAge >= STALE_S;
  const tokenBal = bal.token != null ? tokens(bal.token, coin.decimals) : null;
  const solBal = bal.sol != null ? lamportsToSol(bal.sol) : null;

  // The one reason the primary button is off, in the user's words.
  const blocker: string | null = !chain ? null
    : tradable === false ? "Not tradable from SOL here"
    : pending ? `Awaiting ${sym(pending)} migration`
    : !wallet.connected ? null
    : insufficient ? (side === "buy" ? "Not enough SOL" : `Not enough ${sym(coin)}`)
    : side === "sell" && bal.token === 0n ? `No ${sym(coin)} in this wallet`
    : null;
  const canTrade = !!quote && !!amountIn && !blocker && !quoting && !busy && quote.amountIn === amountIn && quote.side === side;

  // The route as chips: SOL → $ROOT → … → $COIN on a buy, the reverse on a sell.
  const routeCoins = route.data ? [...route.data.coins].reverse() : [];
  const rootQuote = routeCoins[0]?.quoteSymbol ?? "SOL";
  const path: { key: string; label: string; image: string | null; symbol: string | null }[] = route.data
    ? [{ key: "quote", label: rootQuote, image: null, symbol: null }, ...routeCoins.map((c) => ({ key: c.mint, label: sym(c), image: c.image, symbol: c.symbol }))]
    : [];
  if (side === "sell") path.reverse();
  const parent = coin.ancestors[0] ?? null;
  const routeNote = hops <= 1 ? null
    : side === "buy" ? `Buying ${sym(coin)} also buys ${sym(parent)}: your SOL routes through every parent.`
    : `Selling routes back through ${sym(parent)} to SOL.`;
  const tokenUsd = tokenBal != null && coin.priceUsd != null ? tokenBal * coin.priceUsd : null;
  const primary = busy ? "Working…"
    : blocker ?? (!amountIn ? (side === "buy" ? "Enter an amount of SOL" : `Enter an amount of ${sym(coin)}`)
    : quoting && !quote ? "Quoting…"
    : quote && quote.amountIn === amountIn && quote.side === side ? (side === "buy" ? `Buy ≈ ${amount(outTokens)} ${sym(coin)}` : `Sell for ≈ ${sol(outSol)}`)
    : side === "buy" ? `Buy ${sym(coin)}` : `Sell ${sym(coin)}`);
  const impactText = impact == null ? null : impact <= 0 ? signedPct(-impact) : `−${pct(impact)}`;

  return (
    <section className={`card trade ${sheet ? "in-sheet" : ""} ${side}`} aria-label={`Trade ${sym(coin)}`}>
      {sheet && (
        <div className="trade-sheet-head">
          <Logo src={coin.image} label={coin.symbol} size={32} />
          <div><b id={titleId}>{side === "buy" ? "Buy" : "Sell"} {sym(coin)}</b><span className="muted mono">{coin.priceUsd != null ? usd(coin.priceUsd) : sol(coin.priceSol)}</span></div>
          <button type="button" className="sheet-close" aria-label="Close" onClick={onClose}>×</button>
        </div>
      )}
      <div className="trade-tabs" role="tablist" aria-label="Trade side">
        <SlidingPill items="[role=tab]" className="side-pill" />
        <button type="button" role="tab" aria-selected={side === "buy"} className={side === "buy" ? "on buy" : ""} onClick={() => switchSide("buy")}>Buy</button>
        <button type="button" role="tab" aria-selected={side === "sell"} className={side === "sell" ? "on sell" : ""} onClick={() => switchSide("sell")}>Sell</button>
      </div>

      {route.loading && <div className="stack-2"><Skeleton h={40} r={10} /><Skeleton h={52} r={12} /><Skeleton h={28} r={999} /><Skeleton h={48} r={999} /></div>}
      {route.error && !route.data && <ErrorBox error={route.error} retry={route.reload} compact />}
      {route.data && tradable && (
        <div className="route-chips">
          <div className="route-k"><span className="card-label">Route</span><span className="route-hops mono">{hops <= 1 ? "1 hop" : `${hops} hops · one transaction`}</span></div>
          <ol className="sr-only" aria-label={`Route: ${path.map((p) => p.label).join(" to ")}`}>
            {path.map((p) => <li key={p.key}>{p.label}</li>)}
          </ol>
          <RouteFilament side={side} hops={path.map((p): Hop => ({ key: p.key, label: p.label, image: p.image, symbol: p.symbol, self: p.key === coin.mint, quote: p.key === "quote" }))} />
          {routeNote && <p className="route-note">{routeNote}</p>}
        </div>
      )}
      {route.data && tradable === false && (
        <div className="notice warn trade-block">
          <span><b>Not tradable from SOL here.</b> This chain bottoms out in a listed mint other than SOL (USDC or a tokenized stock), so <code>multi_hop_swap</code> cannot start from a SOL wallet. <Ext href={pumpUrl(coin.mint)}>Trade on pump.fun ↗</Ext></span>
        </div>
      )}
      {route.data && tradable && pending && (
        <div className="notice warn trade-block">
          <span><b>{sym(pending)} is awaiting migration.</b> {pending.mint === coin.mint ? "This coin" : "A coin on this chain"} filled its curve and is moving to a PumpSwap pool; pump blocks trades through it until the migration lands (usually minutes). The quote resumes by itself.</span>
          <button type="button" className="btn sm ghost" onClick={route.reload}>Check again</button>
        </div>
      )}

      {route.data && tradable && (
        <>
          <label className="field trade-field">
            <span className="field-row">
              <span>{side === "buy" ? "You pay" : "You sell"}</span>
              {user && (
                <button type="button" className="bal" title="Use the whole balance" onClick={() => side === "buy" ? (bal.sol != null && setInput(exactAmount(bal.sol > reserve ? bal.sol - reserve : 0n, 9))) : setPct(100)}>
                  <i aria-hidden="true" /> {side === "buy" ? (solBal != null ? sol(solBal) : "…") : (tokenBal != null ? amount(tokenBal, sym(coin)) : "…")}
                  {side === "sell" && tokenUsd != null && tokenUsd > 0 && <em>≈ {usd(tokenUsd)}</em>}
                </button>
              )}
            </span>
            <div className={`amount ${side === "buy" && solUsd ? "has-unit" : ""}`}>
              {usdOn
                ? <input ref={inputRef} className="input mono" inputMode="decimal" autoComplete="off" placeholder="0.00" aria-label="Amount in US dollars" value={usdText} disabled={busy || !!pending} onChange={(e) => onUsd(e.target.value)} />
                : <input ref={inputRef} className="input mono" inputMode="decimal" autoComplete="off" placeholder="0.0" value={input} disabled={busy || !!pending} onChange={(e) => setInput(e.target.value.replace(/[^\d.,]/g, ""))} />}
              {side === "buy" && solUsd
                ? <span className="unit-seg seg" role="group" aria-label="Amount unit"><SlidingPill /><button type="button" aria-pressed={!usdOn} onClick={() => setUsdPref(false)}>SOL</button><button type="button" aria-pressed={usdOn} onClick={() => setUsdPref(true)}>USD</button></span>
                : <em>{side === "buy" ? "SOL" : sym(coin)}</em>}
              {usdOn
                ? (inSol != null && <small className="amount-usd mono">= <Tween value={inSol} format={(n) => sol(n)} ms={420} first={420} /></small>)
                : inUsd && <small className="amount-usd mono">≈ <Tween value={inSol != null && solUsd ? inSol * solUsd : inTok != null && coin.priceUsd != null ? inTok * coin.priceUsd : 0} format={(n) => usd(n)} ms={420} first={420} /></small>}
            </div>
          </label>
          <div className="quick">
            {side === "buy"
              ? QUICK_SOL.map((q) => <button key={q} type="button" aria-pressed={input === q} title={solUsd ? `≈ ${usd(Number(q) * solUsd)}` : undefined} onClick={() => setInput(q)}>{q} SOL</button>)
              : QUICK_PCT.map((p) => <button key={p} type="button" disabled={!user || bal.token == null || bal.token === 0n} title={tokenUsd != null ? `≈ ${usd((tokenUsd * p) / 100)}` : undefined} onClick={() => setPct(p)}>{p === 100 ? "MAX" : `${p}%`}</button>)}
          </div>

          <div className="slip">
            <span className="muted"><Term k="slippage">Slippage</Term></span>
            <span className="seg">
              <SlidingPill />
              {SLIPPAGES.map((s) => <button key={s} type="button" aria-pressed={!customOpen && slippage === s} onClick={() => { setCustomOpen(false); setSlip(s); }}>{s / 100}%</button>)}
              <button type="button" aria-pressed={customOpen} onClick={() => setCustomOpen(true)}>custom</button>
            </span>
            {customOpen && <span className="slip-custom"><input className="input mono" inputMode="decimal" aria-label="Custom slippage percent" value={(slippage / 100).toString()} onChange={(e) => { const v = Number(e.target.value.replace(/[^\d.]/g, "")); if (Number.isFinite(v) && v > 0) setSlip(v * 100); }} /><em>%</em></span>}
          </div>
          {slippage >= 1000 && <div className="notice warn compact">High slippage: a fill up to {slippage / 100}% below the quote is accepted.</div>}

          {!amountIn ? <p className="quote-line">Preview is simulated on-chain — exactly what the program will do.</p> : (
            <div className={`quote ${stale ? "stale" : ""}`} aria-live="polite">
              {quoting && !quote ? <div className="quote-empty muted"><i className="spin" aria-hidden="true" /> Simulating {hops} hop{hops === 1 ? "" : "s"}…</div>
                : quoteErr ? <div className={`quote-err ${quoteErr.startsWith("Connect a wallet") ? "muted" : "bad"}`}>{quoteErr}</div>
                : quote ? (
                  <>
                    <div className="quote-main">
                      <span>You receive <small className="muted">(estimated)</small></span>
                      <b className={side === "buy" ? "accent" : "violet"}>{outLabel}</b>
                      {outUsd && <small className="quote-usd mono muted">≈ {outUsd}</small>}
                    </div>
                    <div><span>Min. received <small className="muted">after {slippage / 100}%</small></span><b>{minLabel}</b></div>
                    {impactText && <div><span><Term k="impact">Price impact</Term> <small className="muted">vs spot, fees included</small></span><b className={impactTone} title={`Spot ${sol(spot)} per ${sym(coin)}; simulated fill ${effPrice != null ? sol(effPrice) : "—"}`}>{impactText}</b></div>}
                    <div><span>Network fee</span><b title={`${units.toLocaleString("en-US")} CU limit × ${CU_PRICE_MICRO / 1e6} lamports + 5 000 base`}>{feeSol(networkFee)}{ataRent > 0n && <small className="muted"> + {feeSol(ataRent)} account rent</small>}</b></div>
                    <div><span>pump fees</span><b className="muted" title={`Charged inside the route (protocol fee on the SOL hop, creator fee on ${sym(coin)}), so they are already inside the figures above`}>inside the quote</b></div>
                    <div className="quote-age">
                      <span className={stale ? "warn" : "muted"}>{quoting ? "refreshing…" : `quoted ${quoteAge}s ago`}</span>
                      <button type="button" className="linkish" disabled={quoting} onClick={requote}>↻ refresh</button>
                    </div>
                  </>
                ) : null}
            </div>
          )}

          {steps.length > 0 && <Steps steps={steps} />}
          {!wallet.connected
            ? <WalletMultiButton>{side === "buy" ? `Connect wallet to buy ${sym(coin)}` : `Connect wallet to sell ${sym(coin)}`}</WalletMultiButton>
            : <button type="button" className={`btn lg block trade-go ${side === "buy" ? "accent" : "violet"}`} disabled={!canTrade} onClick={() => setConfirm(true)}>{primary}</button>}
          {insufficient && side === "buy" && need != null && <p className="hint">You need about {sol(lamportsToSol(need))} for this buy: the amount plus the network fee{ataRent > 0n ? ", the token account rent" : ""} and a {sol(lamportsToSol(HEADROOM))} buffer for the wrapped-SOL scratch account (refunded).</p>}
          {tokenBal != null && tokenBal > 0 && (
            <div className="position">
              <span>You hold <b className="mono">{amount(tokenBal, sym(coin))}</b>{tokenUsd != null && <span className="muted mono"> ≈ {usd(tokenUsd)}</span>}</span>
              <span className="position-act">
                <button type="button" className="linkish" onClick={() => sellPct(50)}>Sell 50%</button>
                <button type="button" className="linkish" onClick={() => sellPct(100)}>Sell all</button>
              </span>
            </div>
          )}
          <p className="trade-foot"><LockGlyph />Built in your browser, signed by your wallet.{coin.priceSol == null && " Spot price unavailable, so no impact figure."}</p>
        </>
      )}

      {confirm && quote && amountIn && chain && createPortal(
        <div className="confirm-backdrop" onClick={() => setConfirm(false)}>
          <div ref={confirmRef} className="confirm" role="dialog" aria-modal="true" aria-labelledby="trade-confirm-title" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-head"><Logo src={coin.image} label={coin.symbol} size={32} /><b id="trade-confirm-title">Confirm {side} · {sym(coin)}</b><button type="button" className="sheet-close" aria-label="Cancel" onClick={() => setConfirm(false)}>×</button></div>
            <div className="confirm-rows">
              <div><span>{side === "buy" ? "You pay" : "You sell"}</span><b>{side === "buy" ? sol(inSol) : amount(inTok, sym(coin))}{inUsd && <small> ≈ {inUsd}</small>}</b></div>
              <div><span>You receive ≈</span><b className={side === "buy" ? "accent" : "violet"}>{outLabel}{outUsd && <small> ≈ {outUsd}</small>}</b></div>
              <div><span>Minimum ({slippage / 100}% slippage)</span><b>{minLabel}</b></div>
              {impactText && <div><span>Price impact</span><b className={impactTone}>{impactText}</b></div>}
              <div><span>Route</span><b className="route">{routeLabels(chain, refs, side).join(" → ")}</b></div>
              <div><span>Network fee</span><b>{feeSol(networkFee + ataRent)}</b></div>
              <div><span>Quote age</span><b className={stale ? "warn" : ""}>{quoteAge}s{stale ? " · consider refreshing" : ""}</b></div>
            </div>
            <p className="hint">The transaction fails on-chain (nothing charged beyond the network fee) if the fill falls below the minimum. Your wallet shows the final simulation before you sign.</p>
            <div className="confirm-actions">
              <button type="button" className="btn ghost" onClick={() => { setConfirm(false); requote(); }}>Refresh quote</button>
              <button type="button" className={`btn ${side === "buy" ? "accent" : "violet"}`} onClick={go}>{side === "buy" ? `Buy ${sym(coin)}` : `Sell ${sym(coin)}`}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </section>
  );
}
