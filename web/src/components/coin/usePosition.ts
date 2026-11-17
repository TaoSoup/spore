// The coin page's "Your position" (YourPosition.tsx): the wallet the header shows, its balance of the coin from the
// tab's balance store, the live price, and the wallet's P&L of the coin from /api/pnl/:wallet (lib/position.ts).
//
// What it costs. The balance: the token key rides in the owner's existing getMultipleAccounts (the header and the
// ticket already watch that owner; lib/balances.ts), so no RPC call of its own. /api/pnl is asked only once the wallet
// holds the coin during the visit (lib/position.ts positionMode), never for a wallet that holds nothing here. The
// first ask for a wallet makes the server TRACK it (one of PNL_MAX_WALLETS = 5000; an idle wallet is evicted for it,
// else the answer says "full"), counts against RATE_PNLNEW (20 new wallets per IP per hour; 429 past it) and queues
// the one-time history read: up to PNL_BACKFILL_TX = 1000 transactions on the server's own free "pnl" lane, never the
// metered user endpoint. A Portfolio visit costs exactly the same, once per wallet. No `since`: the server's "all
// time" body, the same cache entry as the Portfolio's default period (10 s per wallet).
// When it is asked again: one request at a time; every POSITION_POLL_MS while the history is read and the tab shows;
// on coming back to the tab when the answer is older than POSITION_REVISIT_MS; and after every landing of the wallet
// (subscribeLanded: a trade sent here, or the live stream's trade of this wallet) at LANDING_RELOADS_MS until the
// answer has caught up with the trade; when it has not by then (a trade behind a cut log, caught up by the server
// once a minute per wallet on a request, or indexed late), the figures are marked and asked again at
// BEHIND_RELOADS_MS. No steady poll: the cost only changes with the wallet's own trades.
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { api, type Coin, type Pnl } from "../../lib/api";
import { useAsync } from "../../lib/hooks";
import { subscribeLanded, useBalances } from "../../lib/balances";
import { useTrader } from "../../lib/trader";
import { tokens } from "../../lib/format";
import { historyRunning } from "../../lib/pnl";
import { BEHIND_RELOADS_MS, LANDING_RELOADS_MS, pnlCaughtUp, pnlForMint, POSITION_POLL_MS, POSITION_REVISIT_MS, positionMode, positionOwner, positionView, SETTLE_GIVE_UP_MS, visitFor, visitMount, landingSettle, settleBehind, settleSaw, settleStep, settleTrades, walletLabel, type PositionOwner, type PositionView, type Settle } from "../../lib/position";
import { sym } from "../Bits";
import { useLive, type LiveCoin } from "./useLiveCoin";

export type Position = PositionView & { owner: PositionOwner | null; walletLabel: string; portfolioLink: boolean; live: Coin; retry: () => void };

/// P&L requests numbered as they are sent, over every card (a settle carried to a card mounted again compares them).
const sent = { current: 0 };

export function usePosition(coin: Coin, store: LiveCoin, solUsd: number | null): Position {
  const { trader, tw, walletName } = useTrader();
  const ext = useWallet().publicKey?.toBase58() ?? null;
  const { connection } = useConnection();
  const traderAddress = trader.publicKey?.toBase58() ?? null;
  const owner = useMemo(() => positionOwner({ traderKind: trader.kind, traderAddress, twStatus: tw.status, twAddress: tw.address }), [trader.kind, traderAddress, tw.status, tw.address]);
  const addr = owner?.address ?? null;
  const ownerKey = useMemo(() => { try { return addr ? new PublicKey(addr) : null; } catch { return null; } }, [addr]);
  const bal = useBalances(connection, ownerKey, { mint: coin.mint, tokenProgram: coin.tokenProgram });
  const token = ownerKey ? bal.token : null;
  const live = useLive(store, (s) => s.coin);
  const quoteLive = useLive(store, (s) => s.quoteUsd?.usd ?? null);
  const mint = coin.mint;
  const key = `${addr}:${mint}`;

  // This visit's state (lib/position.ts visitFor): a card mounted again as the page crosses the phone breakpoint takes
  // it over (a closed position stays, a settle goes on); a new wallet or coin starts over.
  const visit = useMemo(() => visitFor(key, Date.now()), [key]);
  useEffect(() => { const leave = visitMount(visit); return () => leave(Date.now()); }, [visit]);
  // `held` once during this visit (same wallet, same coin): the card then stays while anything is left, and turns
  // "closed" at 0.
  const balance = token === null ? null : tokens(token, live.decimals);
  const valueUsd = balance !== null && live.priceUsd != null ? balance * live.priceUsd : null;
  const mode = positionMode({ balance: token, valueUsd, priced: live.priceUsd != null, wasHeld: visit.held.current });
  useEffect(() => { if (mode === "held") visit.held.current = true; }, [mode, visit]);
  const want = mode !== "none" && !!addr;

  // One request at a time: a reload asked for while one is in flight is skipped (useAsync drops the answer of a call
  // it replaced, so a slow answer would otherwise never land under the 5 s poll).
  // Each request is numbered as it is sent, and its answer keeps the number (seqOf): a landing's settle tells an answer
  // asked before its first reload from one asked after (lib/position.ts settleStep).
  const flight = useRef<object | null>(null);
  const seqOf = useRef(new WeakMap<Pnl, number>());
  const q = useAsync<Pnl | null>(() => {
    if (!want || !addr) return Promise.resolve(null);
    const mark = {}, seq = ++sent.current;
    flight.current = mark;
    return api.pnl(addr).then((p) => { if (p) seqOf.current.set(p, seq); return p; }).finally(() => { if (flight.current === mark) flight.current = null; });
  }, [addr, mint, want]);
  const reloadNow = q.reload;
  const reload = useCallback(() => { if (!flight.current) reloadNow(); }, [reloadNow]);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  // an answer for another wallet (the hook still holds it for one render after a switch) is not used
  const pnlNow = q.data && q.data.wallet === addr ? q.data : null;
  const pnlOne = useMemo(() => pnlForMint(pnlNow, mint), [pnlNow, mint]);

  // After a landing: "updating" while this coin's balance moved and the answer has not caught up (lib/position.ts).
  const [, bump] = useReducer((n: number) => n + 1, 0);
  // `behind`: a settle ended without its answer catching up with this coin's trade: the answer before the trade (and
  // how many trades it lacks), compared with every later one (lib/position.ts settleBehind); the figures are marked
  // until one has caught up
  const { settle, latest, behind, answeredAt } = visit;
  const tokenNow = useRef(token);
  tokenNow.current = token;
  // every change of this coin's balance while a settle runs: a buy then a sell in one settle are two trades
  useEffect(() => { if (settle.current) settleSaw(settle.current, token); }, [token, settle]);
  /// Ends settle `s`: the figures are marked behind while the answer lags the trade.
  const endSettle = useCallback((s: Settle) => {
    settle.current = null;
    // a settle that began behind compares with that older answer itself (s.lag); an earlier trade still not counted
    // otherwise keeps its own answer to compare with
    const b = behind.current;
    const older = b && !pnlCaughtUp(b.ans, latest.current, mint, b.n) ? b : null;
    behind.current = settleBehind(s, latest.current, tokenNow.current, mint) ?? older;
    bump();
  }, [mint, settle, latest, behind]);
  useEffect(() => {
    if (!pnlNow) return;
    latest.current = pnlNow;
    answeredAt.current = Date.now();
    const s = settle.current;
    if (s) {
      const step = settleStep(s, pnlNow, seqOf.current.get(pnlNow) ?? 0, mint, tokenNow.current);
      if (step === "baseline" && !s.before) s.before = pnlNow;
      if (step === "end") endSettle(s);
      return;
    }
    if (behind.current && pnlCaughtUp(behind.current.ans, pnlNow, mint, behind.current.n)) { behind.current = null; bump(); }
  }, [pnlNow, mint, endSettle, settle, latest, behind, answeredAt]);
  useEffect(() => {
    if (!addr) return;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (ms: number, f: () => void) => { const t = setTimeout(() => { timers.delete(t); f(); }, ms); timers.add(t); };
    /// The reloads of settle `s` from its `s.fired`-th on, timed from the last one gone out (a landing: all of them; a
    /// card mounted again mid-settle: the rest, from now), the give-up after the last.
    const arm = (s: Settle) => {
      const at0 = s.fired > 0 ? LANDING_RELOADS_MS[s.fired - 1] : 0;
      LANDING_RELOADS_MS.forEach((ms, i) => { if (i >= s.fired) later(ms - at0, () => {
        if (settle.current !== s) return;
        s.fired = i + 1;
        if (i === 0) s.from = sent.current + 1;   // requests from here on are asked after the trade had time to be indexed
        reloadRef.current();
        if (s.fired === LANDING_RELOADS_MS.length) later(SETTLE_GIVE_UP_MS, () => { if (settle.current === s) endSettle(s); });
      }); });
      if (s.fired >= LANDING_RELOADS_MS.length) later(SETTLE_GIVE_UP_MS, () => { if (settle.current === s) endSettle(s); });
    };
    // past the server's once-a-minute catch-up of a cut log: asked again while the figures are still behind
    const followUp = () => BEHIND_RELOADS_MS.forEach((ms) => later(ms, () => { if (behind.current && !settle.current) reloadRef.current(); }));
    // a card mounted again (the breakpoint crossed) goes on with the visit's settle, or its follow-ups
    if (settle.current) { arm(settle.current); followUp(); } else if (behind.current) followUp();
    const off = subscribeLanded((o) => {
      if (o !== addr) return;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      const prev = settle.current;
      // the balance as the landing is heard (the store reads it at the landing's slot after this listener), not one
      // kept from an earlier answer: a transfer or a late read before this landing is not its trade
      const s = landingSettle(prev, behind.current, latest.current, tokenNow.current);
      settle.current = s;
      bump();
      arm(s);
      followUp();
    });
    // the visit's state stays with it (a card mounted again takes it over; a new wallet or coin has a new visit)
    return () => { off(); for (const t of timers) clearTimeout(t); };
  }, [addr, mint, endSettle, settle, latest, behind]);

  // while the server reads the wallet's history: asked again every few seconds, never while the tab is hidden
  const reading = historyRunning(pnlNow);
  useEffect(() => {
    if (!want || !reading) return;
    const t = setInterval(() => { if (!document.hidden) reload(); }, POSITION_POLL_MS);
    return () => clearInterval(t);
  }, [want, reading, reload]);
  useEffect(() => {
    if (!want) return;
    const on = () => { if (!document.hidden && answeredAt.current > 0 && Date.now() - answeredAt.current > POSITION_REVISIT_MS) reload(); };
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, [want, reload]);

  const s = settle.current;
  const stale = !!s && settleTrades(s, token) > 0;
  const quoteUsd = quoteLive ?? (live.priceUsd != null && live.priceQuote != null && live.priceQuote > 0 ? live.priceUsd / live.priceQuote : null);
  const view = positionView({
    mode, mint, label: sym(live), balanceRaw: token, decimals: live.decimals, priceUsd: live.priceUsd, priceSol: live.priceSol,
    quoteMint: live.quoteMint, solUsd, quoteUsd, pnl: pnlOne, pnlError: !!q.error, stale, behind: !!behind.current,
  });
  return { ...view, owner, walletLabel: walletLabel(owner, walletName), portfolioLink: !!addr && addr === (tw.address ?? ext), live, retry: reload };
}
