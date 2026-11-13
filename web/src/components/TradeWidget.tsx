import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ApiError, pumpUrl, solscanTx, type Coin, type CoinRef } from "../lib/api";
import { routeLabels } from "../lib/chain";
import { PriceMovedError, QUOTE_PROBE, runJupSwap, runSwap, withSlippage } from "../lib/flow";
import { JupPriceMovedError, KNOWN_MINTS, SOL_MINT, jupPath, quoteJup, type JupQuote } from "../lib/jup";
import { ataRentLamports, priorityMicroLamports, quoteSwap, routeVenues, signatureState, swapFeeLamports, swapUnits, CU_PRICE_MICRO, type Side } from "../lib/pump";
import { assetLabel, blockText, forgetCoin, useTradeRoute } from "../lib/trade-route";
import { clearPendingTrade, pendingTradeOf, type PendingTrade } from "../lib/trade-store";
import { useDebounced, useLocalPref, useNow } from "../lib/hooks";
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
/// Lamports kept back on a buy: the WSOL scratch account's rent is refunded in the same
/// transaction but has to be there at the start.
const HEADROOM = 2_100_000n;
/// A quote younger than this opens the confirm sheet at once; an older one is simulated again first.
const FRESH_MS = 5_000;
/// A quote refused for a passing reason (Jupiter busy or rate-limiting, the server restarting) is asked again after this.
const RETRY_MS = 8_000;
/// While a coin on the route waits for its migration, the route is checked again this often.
const PENDING_POLL_MS = 20_000;

const LockGlyph = () => <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2.5" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>;

/// `unwrapped`: lamports of a wrapped-SOL account the user already had that the route closes into the wallet.
/// `jup`: the Jupiter route's quote (its build is what the transaction is compiled from).
type QuoteState = { amountOut: bigint; units: number; unwrapped: bigint; at: number; amountIn: bigint; side: Side; jup?: JupQuote };

/// "12.50" → "12.5", "3.000000000" → "3": the shortest decimal string for an amount field.
const trimNum = (s: string) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);

/// `amountRef`: the page focuses the amount field through it (the chart's empty state); `titleId`:
/// the id of the sheet head, for the phone dialog's aria-labelledby.
/// `current`: the live record (the coin page's store), read on each render so spot price and the
/// dollar figures follow the market without the widget subscribing to every trade.
export type TradeWidgetProps = { coin: Coin; solUsd: number | null; initialSide?: Side; sheet?: boolean; onClose?: () => void; amountRef?: RefObject<HTMLInputElement | null>; titleId?: string; current?: () => Coin;
  /// Told whether a trade is in flight, so the dialog around the widget (the map's quick trade) never closes under it.
  onBusy?: (busy: boolean) => void };

/// Buy from SOL / sell to SOL through every hop of the chain in one multi_hop_swap, or, for a coin priced in a listed
/// asset with no pump SOL pool, through Jupiter (lib/jup.ts). Quotes come from a simulation (no local curve math), so
/// the preview is what the programs do; the widget adds what a terminal needs around it: balances, impact against spot,
/// slippage, fees, the reason a trade is blocked, and a confirm step before the wallet opens.
export default function TradeWidget({ coin: base, solUsd, initialSide = "buy", sheet = false, onClose, amountRef, titleId, current, onBusy }: TradeWidgetProps) {
  // Identity fields (mint, decimals, ancestors) are the same in both; prices come from the live one.
  const live = current?.();
  const coin = live && live.mint === base.mint ? live : base;
  const { connection } = useConnection();
  const wallet = useWallet();
  const toast = useToast();
  const user = wallet.publicKey;
  const userKey = user?.toBase58() ?? null;
  const route = useTradeRoute(coin);
  const chain = route.data?.chain ?? null;
  const block = route.data?.block ?? null;
  const isJup = route.data?.via === "jupiter";
  // `pending` passes by itself (a migration landing); any other block holds, and the widget says why.
  const pending = block?.kind === "pending" ? block.coin : null;
  const tradable = route.data ? !block || block.kind === "pending" : null;
  const blockInfo = block && block.kind !== "pending" ? blockText(block, coin) : null;
  // While a coin on the route waits for its migration, check again on a timer (its record fresh each time).
  const reloadRoute = route.reload;
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => { forgetCoin(pending.mint); reloadRoute(); }, PENDING_POLL_MS);
    return () => clearInterval(t);
  }, [pending, reloadRoute]);
  const [side, setSide] = useState<Side>(initialSide);
  const [input, setInput] = useState("");
  const [slippage, setSlippage] = useLocalPref<number>("slippage", 100);
  const [customOpen, setCustomOpen] = useState(() => !SLIPPAGES.includes(slippage));
  const [steps, setSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  // The confirm sheet opens on a fresh quote: an older one is simulated again first, and the sheet opens on a quote made
  // after this time (ms), never on the one it replaces.
  const [confirmAfter, setConfirmAfter] = useState<number | null>(null);
  const confirmWhenFresh = confirmAfter != null;
  // The last check before the wallet found the price had moved: the sheet says so above the new numbers.
  const [moved, setMoved] = useState(false);
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
  // The field and its debounced copy agree: no quote is asked for an amount still being typed, or for the old amount read
  // in the new side's decimals in the moment after a Buy / Sell switch.
  const settled = input.trim() === dInput;
  const decimalsIn = side === "buy" ? 9 : coin.decimals;
  const amountIn = useMemo(() => parseAmount(dInput, decimalsIn), [dInput, decimalsIn]);
  const ownRef = useRef<HTMLInputElement>(null);
  const inputRef = amountRef ?? ownRef;
  // The phone sheet opens on the amount field as soon as the route is known.
  useEffect(() => { if (sheet && route.data) inputRef.current?.focus({ preventScroll: true }); }, [sheet, route.data, inputRef]);
  const asset = route.data?.asset ?? null;
  const refs = useMemo(() => {
    const m = new Map<string, Coin | CoinRef>([[coin.mint, coin], ...coin.ancestors.map((a) => [a.mint, a] as const)]);
    if (asset) m.set(asset.mint, { mint: asset.mint, name: null, symbol: asset.symbol.includes("…") ? null : asset.symbol, image: null, depth: 0 });
    return m;
  }, [coin, asset]);
  // The last trade of this coin this browser sent and never saw settle (a reload mid-flight, a status that never came
  // back): said before another one goes out.
  const [lastSent, setLastSent] = useState<{ t: PendingTrade; state: "confirmed" | "failed" | "unknown" } | null>(null);
  useEffect(() => {
    setLastSent(null);
    const t = pendingTradeOf(coin.mint);
    if (!t) return;
    let alive = true;
    signatureState(connection, t.sig).catch(() => "unknown" as const).then((state) => {
      if (!alive) return;
      if (state !== "unknown") clearPendingTrade(t.sig);
      setLastSent({ t, state });
    });
    return () => { alive = false; };
  }, [coin.mint, connection]);

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
  // A quote refused for a passing reason (the server's Jupiter queue busy, Jupiter rate-limiting, a server restart) is
  // asked again at this time (ms), as its message promises; any answer clears it.
  const [retryAt, setRetryAt] = useState<number | null>(null);
  // Jupiter's minimum is part of its build, so a slippage change asks for a new one (once the clicks or typing settle:
  // each one costs a request at Jupiter's shared 0.5/s); pump's route applies it when built.
  const dSlippage = useDebounced(slippage, 400);
  const jupSlip = isJup ? dSlippage : 0;
  const coinMint = coin.mint, coinTokenProgram = coin.tokenProgram;
  useEffect(() => {
    setQuoteErr(null);
    if (!chain || !tradable || !amountIn || pending) { setQuote(null); return; }
    if (side === "sell" && !user) { setQuote(null); setQuoteErr("Connect a wallet to quote a sell"); return; }
    if (!settled) return;
    let alive = true;
    const ac = new AbortController();
    setQuoting(true);
    // Before a wallet connects, buys are simulated from a public probe key so the preview works.
    const payer = user ?? QUOTE_PROBE;
    const run: Promise<Omit<QuoteState, "at" | "amountIn" | "side">> = isJup
      ? quoteJup(connection, payer, { mint: coinMint, tokenProgram: coinTokenProgram }, side, amountIn, jupSlip, ac.signal).then((q) => ({ amountOut: q.amountOut, units: q.unitsConsumed, unwrapped: q.unwrapped, jup: q }))
      : quoteSwap(connection, payer, chain, side, amountIn).then((q) => ({ amountOut: q.amountOut, units: q.unitsConsumed, unwrapped: q.unwrapped }));
    run
      .then((q) => { if (alive) { setQuote({ ...q, at: Date.now(), amountIn, side }); setQuoteErr(null); setRetryAt(null); } })
      .catch((e) => {
        if (!alive) return;
        setQuote(null);
        setRetryAt((e instanceof ApiError && [0, 429, 502, 503, 504].includes(e.status)) || e instanceof JupPriceMovedError ? Date.now() + RETRY_MS : null);
        const msg = friendlyError(e);
        // Before a wallet connects the preview pays from a public probe wallet (QUOTE_PROBE) holding a few hundredths of
        // a SOL: a bigger amount fails there for its balance, not the user's, so say what to do instead.
        setQuoteErr(!user && /not enough SOL|insufficient|short by|no SOL yet/i.test(msg) ? "Connect a wallet to quote this amount: the preview wallet holds less SOL than that." : msg);
      })
      .finally(() => { if (alive) setQuoting(false); });
    // a dropped quote is no longer running (the next one, if any, sets it again in the same render)
    return () => { alive = false; ac.abort(); setQuoting(false); };
  }, [chain, tradable, pending, amountIn, side, userKey, connection, user, nonce, isJup, jupSlip, coinMint, coinTokenProgram, settled]);

  // The quote of exactly what the field holds (the debounce caught up, same amount, same side), or null: the sheet shows
  // it and the transaction is built from it, so the minimum always belongs to the amount being sent.
  // A Jupiter quote also belongs to one wallet and one slippage: its build carries both.
  const jupFits = (q: QuoteState) => !q.jup || (q.jup.taker === (userKey ?? QUOTE_PROBE.toBase58()) && q.jup.slippageBps === slippage);
  const quoteFor = quote && amountIn != null && settled && quote.amountIn === amountIn && quote.side === side && jupFits(quote) ? quote : null;
  const sheetOpen = confirm && !!quoteFor && !!chain;
  const confirmRef = useDialog<HTMLDivElement>(sheetOpen, () => { setConfirm(false); setMoved(false); });
  // A sheet whose quote no longer matches closes (and so frees the page: useDialog's inert follows `sheetOpen`).
  useEffect(() => { if (confirm && !sheetOpen) setConfirm(false); }, [confirm, sheetOpen]);
  // The dialog around the widget (the map's quick trade) may not close while a trade is in flight.
  useEffect(() => { onBusy?.(busy); }, [busy, onBusy]);

  // Re-simulate a standing quote on a timer, but never under the user's hands (a confirm sheet
  // open, a transaction in flight) and never in a background tab.
  const quoteAge = quote ? Math.max(0, Math.floor((now * 1000 - quote.at) / 1000)) : 0;
  const requote = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    if (!quote || quoting || busy || confirm || confirmWhenFresh || document.hidden) return;
    if (quoteAge >= REQUOTE_S) requote();
  }, [quote, quoteAge, quoting, busy, confirm, confirmWhenFresh, requote]);
  // The retry after a passing refusal (never in a background tab: it waits for the next one).
  useEffect(() => {
    if (retryAt == null || quote || quoting || busy) return;
    const t = setTimeout(() => { if (document.hidden) setRetryAt(Date.now() + RETRY_MS); else { setRetryAt(null); requote(); } }, Math.max(0, retryAt - Date.now()));
    return () => clearTimeout(t);
  }, [retryAt, quote, quoting, busy, requote]);

  // The priority fee from the network's recent fees on the route's venues, read again with every new quote.
  // On the Jupiter route the venues are the pools of its last quote (unknown before the first one).
  const [micro, setMicro] = useState(CU_PRICE_MICRO);
  const jupVenues = isJup ? (quote?.jup?.ammKeys ?? []).join(",") : "";
  const routeKey = chain ? `${chain.map((l) => l.mint).join(",")}:${side}:${jupVenues}` : "";
  useEffect(() => {
    if (!chain || !tradable) return;
    let alive = true;
    let venues: PublicKey[];
    try { venues = isJup ? jupVenues.split(",").filter(Boolean).map((k) => new PublicKey(k)) : routeVenues(chain, side); } catch { return; }
    if (!venues.length) return;
    priorityMicroLamports(connection, venues).then((m) => { if (alive) setMicro(m); });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey, tradable, connection, nonce]);

  const askConfirm = () => {
    if (quoteFor && Date.now() - quoteFor.at < FRESH_MS) { setConfirm(true); return; }
    setConfirmAfter(Date.now()); requote();
  };
  useEffect(() => {
    if (confirmAfter == null) return;
    if (quoteErr || !amountIn) { setConfirmAfter(null); setMoved(false); return; }
    if (quoteFor && !quoting && quoteFor.at > confirmAfter) { setConfirmAfter(null); setConfirm(true); }
  }, [confirmAfter, quoteFor, quoting, quoteErr, amountIn]);
  const closeConfirm = () => { setConfirm(false); setMoved(false); };
  /// Forget a pending or open confirmation: the side, the amount or the coin changed under it.
  const resetConfirm = () => { setConfirm(false); setConfirmAfter(null); setMoved(false); };

  async function go() {
    // Built from the quote the sheet shows, for the amount and side that quote was made for.
    const q = quoteFor;
    if (!chain || !q || quoting || busy) { closeConfirm(); return; }
    setConfirm(false); setBusy(true); setSteps([]);
    try {
      const { sig } = q.jup
        ? await runJupSwap(connection, wallet, q.jup, setSteps, { units: swapUnits(1, q.units), microLamports: micro, mint: coin.mint, symbol: coin.symbol })
        : await runSwap(connection, wallet, chain, q.side, q.amountIn, q.amountOut, slippage, setSteps, { units: swapUnits(chain.length, q.units), microLamports: micro, mint: coin.mint, symbol: coin.symbol });
      toast.success(side === "buy" ? `Bought ${sym(coin)}` : `Sold ${sym(coin)}`, { href: solscanTx(sig), label: "view transaction" });
      setInput(""); setQuote(null); setSteps([]); setMoved(false);
      refreshBalances();
      // the trade settled: the dialog around the widget may close now (it ignores a close while busy)
      onBusy?.(false);
      onClose?.();
    } catch (e) {
      if (e instanceof PriceMovedError) {
        // Nothing was signed: drop the quote that failed, and reopen the sheet on a new one only.
        setSteps([]); setQuote(null); setMoved(true); setConfirmAfter(Date.now()); requote();
      } else {
        const sent = (e as { sentSig?: string }).sentSig;
        const unsettled = sent && (e as { name?: string }).name !== "OnChainError" && (e as { name?: string }).name !== "ExpiredError";
        if (unsettled) toast.error(`Sent, but Spore could not confirm it yet. Check the transaction before trading ${sym(coin)} again.`, { href: solscanTx(sent), label: "view transaction" });
        else toast.error(friendlyError(e));
        setMoved(false);
      }
    }
    finally { setBusy(false); }
  }

  const switchSide = (s: Side) => { if (s === side || busy) return; resetConfirm(); setSide(s); setInput(""); setQuote(null); setQuoteErr(null); setSteps([]); };
  const pctOf = (p: number) => (bal.token == null ? "" : p === 100 ? exactAmount(bal.token, coin.decimals) : exactAmount((bal.token * BigInt(p)) / 100n, coin.decimals));
  const setPct = (p: number) => { if (bal.token != null) setInput(pctOf(p)); };
  /// "Sell 50%" / "Sell all" under the position: switch to Sell with the amount filled in.
  const sellPct = (p: number) => { if (bal.token == null || busy || confirmWhenFresh) return; resetConfirm(); if (side !== "sell") { setSide("sell"); setQuote(null); setQuoteErr(null); setSteps([]); } setInput(pctOf(p)); inputRef.current?.focus({ preventScroll: true }); };
  const setSlip = (bps: number) => setSlippage(Math.min(5_000, Math.max(1, Math.round(bps))));

  // --- derived figures for the preview ---
  const hops = chain?.length ?? 0;
  // The compute limit the transaction is built with (the simulated use plus a margin, as buildSwapTx gets it); the
  // priority fee is paid on the whole limit, so this is the real worst case.
  const units = swapUnits(isJup ? 1 : hops, quoteFor ? quoteFor.units : null);
  const networkFee = swapFeeLamports(units, micro);
  // Jupiter's route may open more than the coin's account (an intermediate asset's); its simulation measured them all.
  const ataRent = isJup && quote?.jup && quote.jup.taker === userKey ? quote.jup.rent
    : side === "buy" && user && !bal.hasAta ? ataRentLamports(coin.tokenProgram) : 0n;
  // What a buy must leave in the wallet besides the amount itself.
  const reserve = networkFee + ataRent + HEADROOM;
  const need = side === "buy" && amountIn ? amountIn + reserve : null;
  const insufficient = amountIn != null && user != null && (side === "buy" ? bal.sol != null && need != null && need > bal.sol : bal.token != null && amountIn > bal.token);
  const outTokens = quote ? tokens(quote.amountOut, coin.decimals) : null;
  const outSol = quote ? lamportsToSol(quote.amountOut) : null;
  const outLabel = quote ? (side === "buy" ? amount(outTokens, sym(coin)) : sol(outSol)) : null;
  const outUsd = quote ? (side === "buy" ? (coin.priceUsd != null ? usd(outTokens! * coin.priceUsd) : null) : (solUsd ? usd(outSol! * solUsd) : null)) : null;
  // A Jupiter minimum belongs to the slippage its build was asked with: after a change it waits for the new build.
  const minPending = !!quote?.jup && quote.jup.slippageBps !== slippage;
  const minOut = quote && !minPending ? (quote.jup ? quote.jup.minOut : withSlippage(quote.amountOut, slippage)) : null;
  const minLabel = minOut != null ? (side === "buy" ? amount(tokens(minOut, coin.decimals), sym(coin)) : sol(lamportsToSol(minOut))) : null;
  const inSol = amountIn && side === "buy" ? Number(amountIn) / 1e9 : null;
  const inTok = amountIn && side === "sell" ? tokens(amountIn, coin.decimals) : null;
  const inUsd = inSol != null && solUsd ? usd(inSol * solUsd) : inTok != null && coin.priceUsd != null ? usd(inTok * coin.priceUsd) : null;
  // Impact = how far the simulated fill lands from the spot price the page shows. It includes
  // pump's protocol and creator fees (they come out of the same route), which is what the user
  // actually loses versus spot.
  const spot = coin.priceSol;
  // only a quote of what the field holds: the old one, kept while a new amount is quoted, would mix two amounts
  const sameQuote = !!quote && quote.amountIn === amountIn && quote.side === side;
  const impact = sameQuote && spot && spot > 0 && (inSol != null || inTok != null)
    ? (side === "buy" ? 1 - outTokens! / (inSol! / spot) : 1 - outSol! / (inTok! * spot))
    : null;
  const impactTone = impact == null ? "" : impact > 0.15 ? "bad" : impact > 0.05 ? "warn" : "";
  const effPrice = sameQuote && inSol != null && outTokens ? inSol / outTokens : sameQuote && inTok && outSol != null ? outSol / inTok : null;
  const stale = quote && quoteAge >= STALE_S;
  const tokenBal = bal.token != null ? tokens(bal.token, coin.decimals) : null;
  const solBal = bal.sol != null ? lamportsToSol(bal.sol) : null;

  // The one reason the primary button is off, in the user's words.
  const blocker: string | null = !chain ? null
    : blockInfo ? `Not tradable here · ${blockInfo.short}`
    : pending ? `Awaiting ${sym(pending)} migration`
    : !wallet.connected ? null
    : insufficient ? (side === "buy" ? "Not enough SOL" : `Not enough ${sym(coin)}`)
    : side === "sell" && bal.token === 0n ? `No ${sym(coin)} in this wallet`
    : null;
  const canTrade = !!quoteFor && !blocker && !quoting && !busy;
  // The amount, its presets and the side stay put while a confirmation waits for its quote or a trade is in flight.
  const locked = busy || confirmWhenFresh;

  // The route as chips: SOL → $ROOT → … → $COIN on a buy, the reverse on a sell.
  const routeCoins = route.data ? [...route.data.coins].reverse() : [];
  // On the Jupiter route: the mints its last quote passes (SOL → USDC → $HYPE → coin), or SOL → the asset → the coin
  // before one; the asset is the coin's quote, named from the coin's record.
  const jupLegs = isJup && quote?.jup && quote.jup.side === side ? quote.jup.legs : null;
  const jupMints = !isJup ? [] : jupLegs ? (side === "sell" ? jupPath(jupLegs).reverse() : jupPath(jupLegs)) : [SOL_MINT, ...(coin.quoteMint ? [coin.quoteMint] : []), coin.mint];
  const mintLabel = (m: string) => (m === SOL_MINT ? "SOL" : m === coin.mint ? sym(coin) : m === coin.quoteMint ? assetLabel(coin.quoteSymbol) : KNOWN_MINTS[m] ?? `${m.slice(0, 4)}…`);
  // SOL first, then the listed asset whose SOL pool the route starts in (when it does), the root, …, the coin.
  const path: { key: string; label: string; image: string | null; symbol: string | null }[] = !route.data ? []
    : isJup ? jupMints.map((m) => (m === SOL_MINT ? { key: "quote", label: "SOL", image: null, symbol: null } : { key: m, label: mintLabel(m), image: m === coin.mint ? coin.image : null, symbol: m === coin.mint ? coin.symbol : mintLabel(m).replace(/^\$/, "") }))
    : [{ key: "quote", label: "SOL", image: null, symbol: null },
      ...(asset ? [{ key: asset.mint, label: assetLabel(asset.symbol), image: null, symbol: asset.symbol }] : []),
      ...routeCoins.map((c) => ({ key: c.mint, label: sym(c), image: c.image, symbol: c.symbol }))];
  if (side === "sell") path.reverse();
  const parent = coin.ancestors[0] ?? null;
  // The first coin the route passes through on the way to this one: the parent, or the asset's pool for a root.
  const via = parent ? sym(parent) : asset ? assetLabel(asset.symbol) : null;
  const jupVia = isJup ? assetLabel(coin.quoteSymbol) : null;
  const jupVenueNames = jupLegs ? [...new Set(jupLegs.map((l) => l.label))].join(", ") : null;
  const routeNote = isJup
    ? (side === "buy" ? `Jupiter routes your SOL into ${jupVia}, then ${sym(coin)}'s ${coin.migrated ? "pool" : "curve"}, in one transaction` : `Jupiter routes ${sym(coin)} back through ${jupVia} to SOL, in one transaction`) + (jupVenueNames ? ` (via ${jupVenueNames}).` : ".")
    : hops <= 1 || !via ? null
    : side === "buy" ? (parent ? `Buying ${sym(coin)} also buys ${via}: your SOL routes through every parent.` : `Your SOL buys ${via} in its PumpSwap pool first, then ${sym(coin)} with it, in one transaction.`)
    : `Selling routes back through ${via} to SOL.`;
  const legCount = jupLegs ? jupLegs.length : null;
  const routeHops = isJup ? `Jupiter${legCount ? ` · ${legCount} leg${legCount === 1 ? "" : "s"}` : ""} · one transaction` : hops <= 1 ? "1 hop" : `${hops} hops · one transaction`;
  const tokenUsd = tokenBal != null && coin.priceUsd != null ? tokenBal * coin.priceUsd : null;
  const primary = busy ? "Working…"
    : blocker ?? (!amountIn ? (side === "buy" ? "Enter an amount of SOL" : `Enter an amount of ${sym(coin)}`)
    : quoting && !quote ? "Quoting…"
    : quoteFor ? (side === "buy" ? `Buy ≈ ${amount(outTokens)} ${sym(coin)}` : `Sell for ≈ ${sol(outSol)}`)
    : side === "buy" ? `Buy ${sym(coin)}` : `Sell ${sym(coin)}`);
  const impactText = impact == null ? null : impact <= 0 ? signedPct(-impact) : `−${pct(impact)}`;

  return (
    <section className={`card trade ${sheet ? "in-sheet" : ""} ${side}`} aria-label={`Trade ${sym(coin)}`}>
      {sheet && (
        <div className="trade-sheet-head">
          <Logo src={coin.image} label={coin.symbol} size={32} />
          <div><b id={titleId}>{side === "buy" ? "Buy" : "Sell"} {sym(coin)}</b><span className="muted mono">{coin.priceUsd != null ? usd(coin.priceUsd) : sol(coin.priceSol)}</span></div>
          <button type="button" className="sheet-close" aria-label="Close" disabled={busy} title={busy ? "A trade is in flight" : undefined} onClick={onClose}>×</button>
        </div>
      )}
      <div className="trade-tabs" role="tablist" aria-label="Trade side">
        <SlidingPill items="[role=tab]" className="side-pill" />
        <button type="button" role="tab" aria-selected={side === "buy"} className={side === "buy" ? "on buy" : ""} disabled={locked} onClick={() => switchSide("buy")}>Buy</button>
        <button type="button" role="tab" aria-selected={side === "sell"} className={side === "sell" ? "on sell" : ""} disabled={locked} onClick={() => switchSide("sell")}>Sell</button>
      </div>

      {route.loading && <div className="stack-2"><Skeleton h={40} r={10} /><Skeleton h={52} r={12} /><Skeleton h={28} r={999} /><Skeleton h={48} r={999} /></div>}
      {route.error && !route.data && <ErrorBox error={route.error} retry={route.reload} compact />}
      {route.data && tradable && (
        <div className="route-chips">
          <div className="route-k"><span className="card-label">Route</span><span className="route-hops mono">{routeHops}</span></div>
          <ol className="sr-only" aria-label={`Route: ${path.map((p) => p.label).join(" to ")}`}>
            {path.map((p) => <li key={p.key}>{p.label}</li>)}
          </ol>
          <RouteFilament side={side} hops={path.map((p): Hop => ({ key: p.key, label: p.label, image: p.image, symbol: p.symbol, self: p.key === coin.mint, quote: p.key === "quote" }))} />
          {routeNote && <p className="route-note">{routeNote}</p>}
        </div>
      )}
      {lastSent && (
        <div className={`notice ${lastSent.state === "failed" || lastSent.state === "unknown" ? "warn" : ""} compact trade-last`}>
          <span>
            Your last {lastSent.t.side} of {sym(coin)} ({Math.max(1, Math.round((Date.now() - lastSent.t.at) / 60_000))} min ago){" "}
            {lastSent.state === "confirmed" ? "landed." : lastSent.state === "failed" ? "failed on-chain; nothing was traded." : "has not confirmed yet. Check it before trading again."}{" "}
            <Ext href={solscanTx(lastSent.t.sig)}>view ↗</Ext>
          </span>
          <button type="button" className="sheet-close" aria-label="Dismiss" onClick={() => { if (lastSent.state === "unknown") clearPendingTrade(lastSent.t.sig); setLastSent(null); }}>×</button>
        </div>
      )}
      {route.data && blockInfo && (
        <div className="notice warn trade-block">
          <span><b>{blockInfo.title}.</b> {blockInfo.body} <Ext href={pumpUrl(coin.mint)}>Trade on pump.fun ↗</Ext></span>
        </div>
      )}
      {route.data && tradable && pending && (
        <div className="notice warn trade-block">
          <span><b>{sym(pending)} is awaiting migration.</b> {blockText({ kind: "pending", coin: pending }, coin).body}</span>
          <button type="button" className="btn sm ghost" onClick={() => { forgetCoin(pending.mint); route.reload(); }}>Check again</button>
        </div>
      )}

      {route.data && tradable && (
        <>
          <label className="field trade-field">
            <span className="field-row">
              <span>{side === "buy" ? "You pay" : "You sell"}</span>
              {user && (
                <button type="button" className="bal" title="Use the whole balance" disabled={locked} onClick={() => side === "buy" ? (bal.sol != null && setInput(exactAmount(bal.sol > reserve ? bal.sol - reserve : 0n, 9))) : setPct(100)}>
                  <i aria-hidden="true" /> {side === "buy" ? (solBal != null ? sol(solBal) : "…") : (tokenBal != null ? amount(tokenBal, sym(coin)) : "…")}
                  {side === "sell" && tokenUsd != null && tokenUsd > 0 && <em>≈ {usd(tokenUsd)}</em>}
                </button>
              )}
            </span>
            <div className={`amount ${side === "buy" && solUsd ? "has-unit" : ""}`}>
              {usdOn
                ? <input ref={inputRef} className="input mono" inputMode="decimal" autoComplete="off" placeholder="0.00" aria-label="Amount in US dollars" value={usdText} disabled={locked || !!pending} onChange={(e) => onUsd(e.target.value)} />
                : <input ref={inputRef} className="input mono" inputMode="decimal" autoComplete="off" placeholder="0.0" value={input} disabled={locked || !!pending} onChange={(e) => setInput(e.target.value.replace(/[^\d.,]/g, ""))} />}
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
              ? QUICK_SOL.map((q) => <button key={q} type="button" disabled={locked} aria-pressed={input === q} title={solUsd ? `≈ ${usd(Number(q) * solUsd)}` : undefined} onClick={() => setInput(q)}>{q} SOL</button>)
              : QUICK_PCT.map((p) => <button key={p} type="button" disabled={locked || !user || bal.token == null || bal.token === 0n} title={tokenUsd != null ? `≈ ${usd((tokenUsd * p) / 100)}` : undefined} onClick={() => setPct(p)}>{p === 100 ? "MAX" : `${p}%`}</button>)}
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
              {/* the numbers of a quote of what the field holds only: while another amount is asked, the panel says so */}
              {!sameQuote && !quoteErr && (quoting || !settled || !!quote) ? <div className="quote-empty muted"><i className="spin" aria-hidden="true" /> {isJup ? "Asking Jupiter for a route…" : `Simulating ${hops} hop${hops === 1 ? "" : "s"}…`}</div>
                : quoteErr ? <div className={`quote-err ${quoteErr.startsWith("Connect a wallet") ? "muted" : "bad"}`}>{quoteErr}{isJup && /no route/i.test(quoteErr) && <> <Ext href={pumpUrl(coin.mint)}>Trade on pump.fun ↗</Ext></>}{!quoteErr.startsWith("Connect a wallet") && <> <button type="button" className="linkish" disabled={quoting} onClick={() => { setRetryAt(null); requote(); }}>↻ retry</button></>}</div>
                : sameQuote && quote ? (
                  <>
                    <div className="quote-main">
                      <span>You receive <small className="muted">(estimated)</small></span>
                      <b className={side === "buy" ? "accent" : "violet"}>{outLabel}</b>
                      {outUsd && <small className="quote-usd mono muted">≈ {outUsd}</small>}
                    </div>
                    <div><span>Min. received <small className="muted">after {slippage / 100}%</small></span><b className={minPending ? "muted" : undefined}>{minPending ? "requoting…" : minLabel}</b></div>
                    {impactText && <div><span><Term k="impact">Price impact</Term> <small className="muted">vs spot, fees included</small></span><b className={impactTone} title={`Spot ${sol(spot)} per ${sym(coin)}; simulated fill ${effPrice != null ? sol(effPrice) : "—"}`}>{impactText}</b></div>}
                    <div><span>Network fee</span><b title={`${units.toLocaleString("en-US")} CU limit × ${micro / 1e6} lamports priority (recent fees on this route) + 5 000 base`}>{feeSol(networkFee)}{ataRent > 0n && <small className="muted"> + {feeSol(ataRent)} account rent</small>}</b></div>
                    {quote.unwrapped > 0n && <div><span>Wrapped SOL</span><b className="muted" title="Your wallet already holds a wrapped-SOL account; the route closes it, so its balance and rent come back as plain SOL in the same transaction">{sol(lamportsToSol(quote.unwrapped))} unwrapped to SOL</b></div>}
                    {isJup
                      ? <div><span>Route fees</span><b className="muted" title={`Each venue's fee (the pools on the way, pump's protocol and creator fees on ${sym(coin)}) comes out of the route, so it is already inside the figures above. Jupiter's /build adds no fee of its own.`}>inside the quote</b></div>
                      : <div><span>pump fees</span><b className="muted" title={`Charged inside the route (protocol fee on the SOL hop, creator fee on ${sym(coin)}), so they are already inside the figures above`}>inside the quote</b></div>}
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
            : <button type="button" className={`btn lg block trade-go ${side === "buy" ? "accent" : "violet"}`} disabled={!canTrade || confirmWhenFresh} onClick={askConfirm}>{confirmWhenFresh ? "Refreshing the quote…" : primary}</button>}
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
          <p className="trade-foot"><LockGlyph />Built in your browser, signed by your wallet.{isJup && <> Route by <Ext href="https://jup.ag">Jupiter</Ext> (Metis).</>}{coin.priceSol == null && " Spot price unavailable, so no impact figure."}</p>
        </>
      )}

      {sheetOpen && quote && amountIn && chain && createPortal(
        <div className="confirm-backdrop" onClick={closeConfirm}>
          <div ref={confirmRef} className="confirm" role="dialog" aria-modal="true" aria-labelledby="trade-confirm-title" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-head"><Logo src={coin.image} label={coin.symbol} size={32} /><b id="trade-confirm-title">Confirm {side} · {sym(coin)}</b><button type="button" className="sheet-close" aria-label="Cancel" onClick={closeConfirm}>×</button></div>
            {moved && <p className="notice warn compact" role="status">The price moved past your minimum before the wallet opened, so nothing was sent. These are the new numbers.</p>}
            <div className="confirm-rows">
              <div><span>{side === "buy" ? "You pay" : "You sell"}</span><b>{side === "buy" ? sol(inSol) : amount(inTok, sym(coin))}{inUsd && <small> ≈ {inUsd}</small>}</b></div>
              <div><span>You receive ≈</span><b className={side === "buy" ? "accent" : "violet"}>{outLabel}{outUsd && <small> ≈ {outUsd}</small>}</b></div>
              <div><span>Minimum ({slippage / 100}% slippage)</span><b>{minLabel}</b></div>
              {impactText && <div><span>Price impact</span><b className={impactTone}>{impactText}</b></div>}
              <div><span>Route</span><b className="route">{isJup ? `${path.map((p) => p.label).join(" → ")} · Jupiter` : routeLabels(chain, refs, side).join(" → ")}</b></div>
              <div><span>{ataRent > 0n ? "Network fee + account rent" : "Network fee"}</span><b>{feeSol(networkFee + ataRent)}</b></div>
              {quote.unwrapped > 0n && <div><span>Wrapped SOL</span><b>{sol(lamportsToSol(quote.unwrapped))} back as SOL</b></div>}
              <div><span>Quote age</span><b className={stale ? "warn" : ""}>{quoteAge}s{stale ? " · consider refreshing" : ""}</b></div>
            </div>
            <p className="hint">Spore simulates this exact transaction before your wallet opens; if the price has moved past the minimum, it stops and shows new numbers. On-chain, the trade fails (nothing charged beyond the network fee) if the fill falls below the minimum.{isJup && " The route and its minimum are Jupiter's; Spore checked that the transaction only swaps and sets up your own token accounts."}</p>
            <div className="confirm-actions">
              <button type="button" className="btn ghost" onClick={() => { closeConfirm(); requote(); }}>Refresh quote</button>
              <button type="button" className={`btn ${side === "buy" ? "accent" : "violet"}`} disabled={quoting || busy} onClick={go}>{side === "buy" ? `Buy ${sym(coin)}` : `Sell ${sym(coin)}`}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </section>
  );
}
