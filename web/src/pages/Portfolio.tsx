// The Portfolio page: for one wallet, two lists under three summary figures. No profit and loss.
// HOLDINGS: the coins the wallet bought (it holds them and did not launch them), one flat list, largest value first.
// YOUR SPORES: the pairs the wallet launched (a child coin under a parent, priced in the parent's token) and the coins
// whose creator fees it shares, one card per parent coin; each row has its fees to claim. A coin is in one list only.
// The wallet shown is the user's trading wallet (the browser wallet they trade with; its address is known while it is
// locked). There is no switch between wallets: a connected extension wallet is how the account was made, so the pairs
// it launched before and the fees their splits pay it are listed with the trading wallet's own. Without a trading
// wallet the connected wallet is shown. /portfolio?wallet=<address> shows any address
// read-only. Numbers come from /api/portfolio/:wallet and /api/claims/:wallet (lib/portfolio.ts sorts them into the
// two lists). Buy / Sell open the quick-trade ticket and trade with the wallet shown: a locked trading wallet is
// asked to unlock first, and an unlocked one is made the wallet that trades (lib/trader.ts).
// Claims are built in the browser and signed by the account wallet (useClaimFlow, lib/trader.ts useAccount): the
// trading wallet when there is one (unlocked first; it signs on the confirm dialog's button, with no popup), else the
// connected wallet. A payout is permissionless and pays the wallets of the coin's fee split, so the trading wallet
// also runs the payouts of coins the connected wallet launched: their part goes to the connected wallet, and the
// dialog says so. Long lists are cut:
// 10 holdings, 12 parent cards and 5 rows a card, the rest behind a button.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { api, errorMessage, pumpUrl, type Candle, type Candles, type ClaimCoin, type Coin } from "../lib/api";
import { useAsync, useStats } from "../lib/hooks";
import { ago, amount, count, lamportsToSol, plural, short, signedPct, sol, tokens, usd, usdCard } from "../lib/format";
import { buildPortfolio, claimableRows, type PfClaim, type PfGroup, type PfRow } from "../lib/portfolio";
import { blockText, hardBlock, loadTradeRoute } from "../lib/trade-route";
import { openTradingWallet, useTrader } from "../lib/trader";
import type { Side } from "../lib/pump";
import { Addr, ErrorBox, Logo, SkeletonRows, sym } from "../components/Bits";
import { Sprout } from "../components/LaunchButton";
import QuickTrade from "../components/QuickTrade";
import { candleChange, spanLabel } from "../components/map/panel/Sparkline";
import { useToast } from "../components/Toast";
import { useClaimFlow, type ClaimTarget } from "../components/claim/useClaimFlow";
import "../components/portfolio/portfolio.css";

const POLL_MS = 15_000;
const CLAIM_CACHE_MS = 16_000; // the API caches a coin's fees for 15 s; read again after a claim once it has turned over
const TRADE_SETTLE_MS = 4_000; // a trade's new balance and price reach the API a few seconds after it lands
const BLOCK_READ_MS = 5_000;   // a "not tradable here" reason stays at least this long, so a refresh right after the click does not hide it unread
const CARDS_STEP = 12;         // parent cards shown at first, and added by "Show more"
const ROWS_MAX = 5;            // rows a card shows before "Show all"
const HOLDINGS_MAX = 10;       // holdings shown before "Show all"
const target = (c: ClaimCoin): ClaimTarget => ({ mint: c.mint, symbol: c.symbol, image: c.image, quoteSymbol: c.quoteSymbol, quoteDecimals: c.quoteDecimals, total: c.total, perShare: c.perShare, depth: c.depth });
const feeText = (k: PfClaim) => amount(tokens(k.amount, k.quoteDecimals), k.quoteSymbol);
const mapLink = (mint: string) => `/map?focus=${encodeURIComponent(mint)}`;
/// A base58 Solana address, or null.
function address(s: string | null): string | null {
  if (!s) return null;
  try { return new PublicKey(s.trim()).toBase58(); } catch { return null; }
}

type Opening = { mint: string; side: Side } | null;
type Blocked = Record<string, { short: string; body: string; at: number }>;
type Flow = ReturnType<typeof useClaimFlow>;
/// What a card needs from the page: the trade opener and its state, and the claim flow (null: no Claim buttons).
/// `buy`: a wallet of the user's can trade; `sell`: that wallet is the one shown, so its holdings are the ticket's.
/// `readOnly`: the wallet shown is not the user's.
type Actions = { opening: Opening; blocked: Blocked; onTrade: (mint: string, side: Side) => void; flow: Flow | null; buy: boolean; sell: boolean; readOnly: boolean };

export default function Portfolio() {
  useEffect(() => { document.title = "Portfolio · Spore"; return () => { document.title = "Spore"; }; }, []);
  const [params] = useSearchParams();
  const { connection } = useConnection();
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const { trader, tw, tradeWith, setTradeWith } = useTrader();
  const { stats } = useStats();
  const toast = useToast();

  // The wallet shown: the trading wallet, else the connected wallet; ?wallet= shows any address read-only.
  const ext = wallet.publicKey?.toBase58() ?? null;
  const mine = tw.address ?? ext;
  const asked = params.get("wallet");
  const preview = address(asked);
  const shown = preview ?? mine;
  const readOnly = !!preview && preview !== tw.address && preview !== ext;
  const isTrading = !!shown && shown === tw.address;
  // The connected wallet beside a trading wallet: it signed the launches, so its pairs and fees belong on the page.
  const also = !preview && tw.address && ext && ext !== tw.address ? ext : null;
  // Tickets trade with the wallet shown: the trading wallet (unlocked on the click), or the connected wallet when
  // there is no trading wallet. A read-only view can still buy with the user's own wallet.
  const tradeAddr = tw.address ?? trader.publicKey?.toBase58() ?? null;
  const tradesShown = !!shown && !readOnly && shown === tradeAddr;
  const locked = isTrading && !readOnly && tw.status !== "unlocked";

  // Latest reloaders, read when a claim or a trade lands (the flow hook is created before the fetches).
  const reloadRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => reloadRef.current(), []);
  const onClaimed = useCallback(() => { refresh(); setTimeout(refresh, CLAIM_CACHE_MS); }, [refresh]);
  const flow = useClaimFlow(onClaimed);
  const pf = useAsync(() => (shown ? api.portfolio(shown) : Promise.resolve(null)), [shown]);
  const pf2 = useAsync(() => (also ? api.portfolio(also).catch(() => null) : Promise.resolve(null)), [also]);
  // Fees are a second read: when it fails the holdings still show, without amounts to claim.
  const claims = useAsync(() => (shown ? api.claimsFor(shown) : Promise.resolve(null)), [shown]);
  const claims2 = useAsync(() => (also ? api.claimsFor(also).catch(() => null) : Promise.resolve(null)), [also]);
  reloadRef.current = () => { pf.reload(); claims.reload(); if (also) { pf2.reload(); claims2.reload(); } };

  const [trade, setTrade] = useState<{ coin: Coin; side: Side } | null>(null);
  const [opening, setOpening] = useState<Opening>(null);
  const [blocked, setBlocked] = useState<Blocked>({});
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const busyRef = useRef(false);
  // Buy / Sell: the ticket needs the coin's full record, and a coin that cannot be traded here says why in its row.
  const onTrade = useCallback(async (mint: string, side: Side) => {
    if (busyRef.current) return;
    // the trading wallet trades here: a locked one is unlocked first, an unlocked one is made the wallet that trades
    if (tw.address) {
      if (tw.status !== "unlocked") { openTradingWallet(); toast.info("Unlock your trading wallet to trade."); return; }
      if (tradeWith !== "trading") setTradeWith("trading");
    }
    busyRef.current = true;
    setOpening({ mint, side });
    try {
      const { coin } = await api.coin(mint, { children: false, trades: false });
      // a route check that fails (the RPC) opens the ticket anyway: it checks the route itself and offers a retry
      const route = await loadTradeRoute(connection, coin).catch(() => null);
      if (!alive.current) return;
      const block = hardBlock(route);
      if (!block) setTrade({ coin, side });
      else {
        const t = blockText(block, coin);
        // a gap passes once the index holds the coins above: it is said once and the buttons stay, so the next click checks again
        if (block.kind === "gap") toast.info(`${t.title}. ${t.body}`);
        else setBlocked((b) => ({ ...b, [mint]: { short: t.short, body: t.body, at: Date.now() } }));
      }
    } catch (e) {
      toast.error(`Could not open the trade: ${errorMessage(e)}`);
    } finally {
      busyRef.current = false;
      if (alive.current) setOpening(null);
    }
  }, [connection, toast, tw.address, tw.status, tradeWith, setTradeWith]);
  const closeTrade = useCallback(() => { setTrade(null); refresh(); setTimeout(refresh, TRADE_SETTLE_MS); }, [refresh]);

  // Refresh while the tab is visible, and at once when it comes back; never under an open ticket or a running claim.
  const idle = !flow.busy && !trade;
  useEffect(() => {
    if (!shown || !idle) return;
    const tick = () => { if (!document.hidden) refresh(); };
    const t = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", tick); };
  }, [shown, idle, refresh]);

  // The page's portfolio: the wallet shown, with the pairs the connected wallet launched added to its own.
  const data = useMemo(() => {
    const a = pf.data, b = also ? pf2.data : null;
    if (!a || !b) return a;
    const seen = new Set(a.launched.map((c) => c.mint));
    return { ...a, launched: [...a.launched, ...b.launched.filter((c) => !seen.has(c.mint))], launchedTotal: a.launchedTotal + b.launchedTotal };
  }, [pf.data, pf2.data, also]);
  const claimCoins = useMemo(() => [...(claims.data?.coins ?? []), ...((also ? claims2.data?.coins : null) ?? [])], [claims.data, claims2.data, also]);
  // A stored reason is dropped when the portfolio is read again (and with the wallet shown): the buttons come back and
  // the next click checks the route again.
  useEffect(() => {
    setBlocked((b) => {
      const now = Date.now(), keep = Object.entries(b).filter(([, v]) => now - v.at >= 0 && now - v.at < BLOCK_READ_MS);
      return keep.length === Object.keys(b).length ? b : Object.fromEntries(keep);
    });
  }, [data]);
  const [cards, setCards] = useState(CARDS_STEP);
  useEffect(() => { setCards(CARDS_STEP); }, [shown]);
  const view = useMemo(() => buildPortfolio(data, claimCoins), [data, claimCoins]);
  const toClaim = useMemo(() => claimableRows(view), [view]);
  const { totals, groups, holdings } = view;
  const [allHeld, setAllHeld] = useState(false);
  useEffect(() => { setAllHeld(false); }, [shown]);
  const solBalance = data?.solLamports != null ? lamportsToSol(data.solLamports) : null;
  const canClaim = !readOnly && !!flow.me;
  const actions: Actions = { opening, blocked, onTrade, flow: canClaim ? flow : null, buy: !!tradeAddr, sell: tradesShown, readOnly };
  const feesFailed = !!claims.error && !claims.data;
  // before the first answer for this wallet; a background refresh keeps the amount on screen
  const feesPending = !claims.data && !claims.error;

  return (
    <>
      <div className="pf-page">
        <header className="pf-head">
          <h1>Portfolio</h1>
          <p className="pf-sub">{readOnly ? "The coins this wallet holds, and the pairs it launched." : "The coins you hold, and the pairs you launched."}</p>
          {asked && !preview && <p className="pf-note" role="status">"{short(asked, 6)}" is not a wallet address.{shown ? " Showing your own wallet." : ""}</p>}
          {shown && (
            <p className="pf-note pf-trades" role="status">
              {readOnly
                ? <span>Viewing <Addr a={shown} />, read only{mine && <> · <Link to="/portfolio" className="pf-link">Back to my wallet</Link></>}</span>
                : <span>{isTrading ? "Trading wallet" : "Connected wallet"} <Addr a={shown} />{locked && " · locked"}</span>}
              {locked && <button type="button" className="btn sm ghost" onClick={() => openTradingWallet()}>Unlock</button>}
            </p>
          )}
        </header>

        {!shown ? (
          <section className="card pf-connect" aria-labelledby="pf-connect-h">
            <h2 id="pf-connect-h">See what your wallet holds</h2>
            <p>Connect a wallet, or create a trading wallet in this browser, to see your coins, the coins you launched and the fees they earned.</p>
            <div className="pf-connect-acts">
              <button type="button" className="btn accent" onClick={() => setVisible(true)}>Connect wallet</button>
              <button type="button" className="btn ghost" onClick={() => openTradingWallet()}>Create trading wallet</button>
            </div>
          </section>
        ) : pf.loading && !data ? (
          <div aria-busy="true" aria-label="Loading the portfolio"><SkeletonRows n={4} h={72} /></div>
        ) : pf.error && !data ? (
          <ErrorBox error="The portfolio could not be loaded." retry={pf.reload} details={pf.error} />
        ) : data && (
          <>
            <dl className="pf-sum" aria-label="Summary">
              <div className="pf-tile">
                <dt>Total value</dt>
                <dd className="pf-num">{data.holdingsOk ? usdCard(totals.valueUsd) : "—"}</dd>
                <dd className="pf-tile-sub">
                  {data.holdingsOk ? `${plural(totals.holdings, "holding")} · ${plural(totals.sporeTotal, "spore")}` : "could not be read"}
                  {totals.unpriced > 0 && ` · ${totals.unpriced} without a price`}
                  {data.untracked > 0 && ` · ${plural(data.untracked, "other token")} not on Spore`}
                </dd>
              </div>
              <div className="pf-tile">
                <dt>SOL balance</dt>
                <dd className="pf-num">{sol(solBalance)}</dd>
                <dd className="pf-tile-sub">{solBalance === null ? "could not be read" : stats?.solUsd ? usdCard(solBalance * stats.solUsd) : " "}</dd>
              </div>
              <div className="pf-tile">
                <dt>Fees to claim</dt>
                <dd className="pf-num" aria-busy={feesPending}>{feesFailed || feesPending ? "—" : usdCard(totals.claimUsd)}</dd>
                <dd className="pf-tile-sub pf-tile-act">
                  {feesFailed ? <>could not be read · <button type="button" className="linkish" onClick={claims.reload}>retry</button></>
                    : feesPending ? "reading…"
                    : toClaim.length === 0 ? "nothing waiting"
                    : readOnly ? plural(toClaim.length, "coin")
                    : !flow.me ? <button type="button" className="linkish" onClick={() => setVisible(true)}>Connect a wallet to claim</button>
                    : (
                      <button type="button" className="btn sm accent" disabled={flow.bulk ? flow.bulk.stopping : flow.busy} onClick={() => (flow.bulk ? flow.stop() : flow.claimAll(toClaim.map(target), totals.claimUsd))}
                        title={flow.bulk ? "Stops after the coin in flight; coins already paid out stay paid" : flow.locked ? "Your trading wallet signs the payouts: unlock it first" : flow.silent ? "One payout per coin, signed by your trading wallet after you confirm the list with each coin's cost" : "One payout per coin, each approved in the connected wallet"}>
                        {flow.bulk ? (flow.bulk.stopping ? "Stopping…" : `Stop · claiming ${flow.bulk.i + 1} of ${flow.bulk.n}`) : flow.locked ? `Unlock to claim (${toClaim.length})` : `Claim all (${toClaim.length})`}
                      </button>
                    )}
                </dd>
              </div>
            </dl>

            <section className="pf-sec" aria-labelledby="pf-held-h">
              <div className="pf-sec-head">
                <h2 id="pf-held-h">Holdings</h2>
                {holdings.length > 0 && <span className="pf-count">{plural(holdings.length, "coin")} {readOnly ? "bought" : "you bought"}</span>}
              </div>
              {!data.holdingsOk ? (
                <p className="pf-warn" role="status">Holdings could not be read just now, so only the coins this wallet launched are listed. <button type="button" className="linkish" onClick={pf.reload}>Retry</button></p>
              ) : holdings.length === 0 ? (
                <p className="pf-empty">{readOnly ? "This wallet holds no coins it bought." : "Coins you buy show up here."} <Link to="/map" className="pf-link">Find one on the map</Link></p>
              ) : (
                <div className={`card pf-holds ${actions.buy ? "" : "pf-holds-plain"}`}>
                  <div className="pf-hold pf-hold-cols" aria-hidden="true">
                    <span /><span>Coin</span><span>Price</span><span>Amount</span><span>Value</span><span>24 h volume</span>{actions.buy && <span />}
                  </div>
                  <ul className="pf-rows" aria-label="Holdings">
                    {(allHeld ? holdings : holdings.slice(0, HOLDINGS_MAX)).map((r) => <HoldingRow key={r.coin.mint} r={r} a={actions} />)}
                  </ul>
                  {holdings.length > HOLDINGS_MAX && (
                    <button type="button" className="linkish pf-link pf-all" aria-expanded={allHeld} onClick={() => setAllHeld((v) => !v)}>
                      {allHeld ? "Show fewer" : `Show all ${holdings.length}`}<span className="sr-only"> holdings</span>
                    </button>
                  )}
                </div>
              )}
            </section>

            <section className="pf-sec" aria-labelledby="pf-spores-h">
              <div className="pf-sec-head">
                <h2 id="pf-spores-h">{readOnly ? "Spores" : "Your spores"}</h2>
                {groups.length > 0 && <span className="pf-count">{readOnly ? "Pairs this wallet launched" : "Pairs you launched"}, by parent coin</span>}
              </div>
              {groups.length === 0 ? (
                <p className="pf-empty">
                  {readOnly ? "This wallet has not launched a pair." : "A pair you launch shows up here, with the fees it earns."}
                  {!readOnly && <> <Link to="/launch" className="btn sm accent"><Sprout />Launch a coin</Link></>}
                </p>
              ) : (
                <div className="pf-grid">
                  {groups.slice(0, cards).map((g) => <GroupCard key={g.mint} g={g} a={actions} />)}
                </div>
              )}
              {groups.length > cards && (
                <button type="button" className="btn ghost pf-more" onClick={() => setCards((n) => n + CARDS_STEP)}>
                  Show more <span className="pf-k">{cards} of {groups.length} parents</span>
                </button>
              )}
              {data.launchedTotal > data.launched.length && <p className="pf-note">Showing the newest {data.launched.length} of {data.launchedTotal} launched coins.</p>}
            </section>
          </>
        )}
      </div>
      {flow.dialog}
      {trade && <QuickTrade coin={trade.coin} side={trade.side} solUsd={stats?.solUsd ?? null} onClose={closeTrade} />}
    </>
  );
}

/// Buy / Sell for one coin, or the reason it cannot be traded here with the way out. Sell only when the wallet shown
/// holds the coin and is the wallet the ticket trades with; nothing when no wallet of the user's can trade.
function TradeButtons({ mint, label, held, a }: { mint: string; label: string; held: boolean; a: Actions }) {
  if (!a.buy) return null;
  const canSell = a.sell && held;
  const why = a.blocked[mint];
  if (why) return <span className="pf-why" title={why.body}>Not tradable here: {why.short} · <a href={pumpUrl(mint)} target="_blank" rel="noreferrer">pump.fun ↗</a></span>;
  const busy = (side: Side) => a.opening?.mint === mint && a.opening.side === side;
  return (
    <span className="pf-trade">
      <button type="button" className={`btn sm ghost pf-buy ${busy("buy") ? "is-busy" : ""}`} disabled={!!a.opening} aria-busy={busy("buy")} aria-label={`Buy ${label}`} onClick={() => a.onTrade(mint, "buy")}>Buy</button>
      {canSell && <button type="button" className={`btn sm ghost pf-sell ${busy("sell") ? "is-busy" : ""}`} disabled={!!a.opening} aria-busy={busy("sell")} aria-label={`Sell ${label}`} onClick={() => a.onTrade(mint, "sell")}>Sell</button>}
    </span>
  );
}

/// A coin's fees waiting for the wallet, with Claim when a payout can run and the page may claim.
function Fee({ k, label, a }: { k: PfClaim; label: string; a: Actions }) {
  const flow = a.flow;
  return (
    <span className="pf-fee">
      <span className="pf-k">Fees</span>
      <span className="pf-num" title={k.usd != null ? usd(k.usd) : undefined}>{feeText(k)}</span>
      {!k.claimable ? <span className="pf-k" title={k.row.reason ?? undefined}>not claimable</span>
        : flow && <button type="button" className="btn sm soft" disabled={flow.busy} aria-label={flow.locked ? `Unlock your trading wallet to claim the fees of ${label}` : `Claim the fees of ${label}`} title={flow.locked ? "Your trading wallet signs the payout: unlock it first" : undefined} onClick={() => flow.start(target(k.row))}>{flow.labelFor(k.row.mint) ?? (flow.locked ? "Unlock to claim" : "Claim")}</button>}
    </span>
  );
}

/// What the wallet holds of a coin: its value, or the token amount when it has no price; a dash when it holds none.
const heldText = (r: PfRow | null) => (!r?.held ? "—" : r.held.valueUsd != null ? usdCard(r.held.valueUsd) : amount(r.held.uiAmount));
const heldTitle = (r: PfRow | null) => (r?.held ? `${amount(r.held.uiAmount)} ${sym(r.coin)}` : undefined);
/// Why a coin is among the spores: the wallet launched it, or only shares its fees.
const SporeTag = ({ r }: { r: PfRow }) => (r.launched ? <span className="pf-tag">launched</span> : r.feeShare ? <span className="pf-tag" title="Listed because this wallet receives a share of the coin's creator fees">fee share</span> : null);

/// One coin the wallet bought: logo, symbol over its pair, amount, value, 24 h volume, Buy / Sell. The cells line up
/// in columns on a wide screen (portfolio.css); on a phone the value sits over the amount on the first line and the
/// volume and the buttons take the second. Every figure keeps a label for a screen reader.
function HoldingRow({ r, a }: { r: PfRow; a: Actions }) {
  const c = r.coin, name = sym(c), h = r.held;
  return (
    <li className="pf-hold">
      <Logo src={c.image} label={c.symbol} size={28} />
      <span className="pf-hold-main">
        <Link to={mapLink(c.mint)} className="pf-sym" title={`${c.name ?? name} on the map`}>{name}</Link>
        {c.parent && <span className="pf-name" title={`Priced in ${sym(c.parent)}`}>in {sym(c.parent)}</span>}
      </span>
      <span className="pf-hold-val">
        <span className="sr-only">Value </span>
        {h?.valueUsd != null ? <b className="pf-num">{usdCard(h.valueUsd)}</b> : <span className="pf-k">no price</span>}
      </span>
      <span className="pf-hold-amt"><span className="sr-only">Amount </span><span className="pf-num">{amount(h?.uiAmount)}</span></span>
      <PriceCell r={r} />
      <div className="pf-hold-foot">
        <span className="pf-hold-vol"><span className="pf-k">24 h vol</span> <span className="pf-num">{usd(c.vol24Usd)}</span></span>
        {a.buy && <span className="pf-hold-act"><TradeButtons mint={c.mint} label={name} held={!!h} a={a} /></span>}
      </div>
    </li>
  );
}

/// 5-minute candles of a coin, shared by every row that asks and read again after a minute. null: none to show.
const CANDLES_MS = 60_000;
const candleCache = new Map<string, { at: number; p: Promise<Candles | null> }>();
function useCandles(mint: string, on = true): Candles | null | undefined {
  const [got, setGot] = useState<{ mint: string; c: Candles | null } | null>(null);
  const epoch = Math.floor(Date.now() / CANDLES_MS);
  useEffect(() => {
    if (!on) return;
    let live = true;
    let e = candleCache.get(mint);
    if (!e || Date.now() - e.at >= CANDLES_MS) { e = { at: Date.now(), p: api.candles(mint, 300, "all").catch(() => null) }; candleCache.set(mint, e); }
    e.p.then((c) => { if (live) setGot({ mint, c }); });
    return () => { live = false; };
  }, [mint, epoch, on]);
  return got && got.mint === mint ? got.c : undefined;
}

/// The closes of the candle window as one quiet line: lime when it ends above its open, red when below.
const LINE_W = 96, LINE_H = 26;
function MiniLine({ candles }: { candles: Candle[] }) {
  const d = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (const k of candles) { if (k.c < lo) lo = k.c; if (k.c > hi) hi = k.c; }
    const span = hi - lo || Math.abs(hi) || 1, t0 = candles[0].t, dt = candles[candles.length - 1].t - t0 || 1;
    return candles.map((k, i) => `${i ? "L" : "M"}${(2 + ((k.t - t0) / dt) * (LINE_W - 4)).toFixed(1)} ${(3 + (1 - (k.c - lo) / span) * (LINE_H - 6)).toFixed(1)}`).join("");
  }, [candles]);
  const up = candles[candles.length - 1].c >= candles[0].o;
  return <svg className={`pf-line ${up ? "up" : "down"}`} width={LINE_W} height={LINE_H} viewBox={`0 0 ${LINE_W} ${LINE_H}`} aria-hidden="true"><path d={d} fill="none" strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" /></svg>;
}

/// A coin's market at a glance: price, the line of the candles the index has, the change over them, and how lately
/// and how often it trades. The candles are read once the row is near the screen, so a long page asks for few.
function PriceCell({ r }: { r: PfRow }) {
  const c = r.coin;
  const box = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = box.current;
    if (seen || !el) return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) setSeen(true); }, { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  const candles = useCandles(c.mint, seen);
  const list = candles?.candles ?? [];
  const change = candleChange(list);
  const n24 = c.trades24h ?? 0;
  return (
    <div className="pf-hold-px" ref={box}>
      <span className="pf-px-main">
        <span className="sr-only">Price </span><b className="pf-num">{usd(c.priceUsd)}</b>
        <span className="pf-px-meta" title={c.lastTradeAt ? `Last trade ${ago(c.lastTradeAt)}${n24 > 0 ? `, ${count(n24)} trades in 24 h` : ""}` : undefined}>{c.lastTradeAt ? <>{ago(c.lastTradeAt)}{n24 > 0 && <> · {n24 >= 10_000 ? amount(n24) : count(n24)} tx 24h</>}</> : "no trade in 24 h"}</span>
      </span>
      <span className="pf-px-line">{list.length >= 2 && <MiniLine candles={list} />}</span>
      {change
        ? <span className={`pf-chg ${change.ratio >= 0 ? "up" : "down"}`} title={`Change over the last ${spanLabel(change.spanS)}`}>{signedPct(change.ratio)} · {spanLabel(change.spanS)}</span>
        : <span className="pf-chg none" title={candles === undefined ? "Reading the chart" : "No chart for this coin yet"}>—</span>}
    </div>
  );
}

/// One parent coin and the pairs the wallet launched under it. The header is the parent; it carries a tag, fees and
/// Buy / Sell of its own only when the parent is itself one of the wallet's spores (`g.self`).
function GroupCard({ g, a }: { g: PfGroup; a: Actions }) {
  const id = useId();
  const [all, setAll] = useState(false);
  const p = g.parent, self = g.self;
  const label = sym(p);
  // a parent the index does not track (a listed asset such as USDC) has no ticket and takes no child here
  const tracked = g.tracked;
  const rows = all ? g.rows : g.rows.slice(0, ROWS_MAX);
  return (
    <article className="card pf-card" aria-labelledby={id}>
      <header className="pf-card-head">
        <Logo src={p.image} label={p.symbol} size={40} />
        <div className="pf-card-title">
          <h3 id={id}><Link to={mapLink(p.mint)} className="pf-sym" title={`${label} on the map`}>{label}</Link>{self && <SporeTag r={self} />}</h3>
          <span className="pf-name" title={p.mint}>{p.name ?? (tracked ? short(p.mint, 4) : "not on Spore")}</span>
        </div>
        {g.rows.length > 0 && <span className="pf-count">{plural(g.rows.length, "pair")}</span>}
      </header>
      {self && (self.held || self.claim || a.buy) && (
        <div className="pf-card-own">
          {self.held && <span className="pf-meta"><span className="pf-k">{a.readOnly ? "Holds" : "You hold"}</span> <span className="pf-num" title={heldTitle(self)}>{heldText(self)}</span></span>}
          {self.claim && <Fee k={self.claim} label={label} a={a} />}
          {tracked && <TradeButtons mint={p.mint} label={label} held={!!self.held} a={a} />}
        </div>
      )}
      {g.rows.length > 0 && (
        <ul className="pf-rows" aria-label={`${a.readOnly ? "Pairs" : "Your pairs"} under ${label}`}>
          {rows.map((r) => {
            const c = r.coin, name = sym(c);
            return (
              <li key={c.mint} className="pf-row">
                <Logo src={c.image} label={c.symbol} size={28} />
                <span className="pf-row-main">
                  <Link to={mapLink(c.mint)} className="pf-sym" title={`${c.name ?? name} on the map`}>{name}</Link>
                  {r.feeShare && <SporeTag r={r} />}
                </span>
                <TradeButtons mint={c.mint} label={name} held={!!r.held} a={a} />
                <PriceCell r={r} />
                <div className="pf-row-foot">
                  <span className="pf-meta"><span className="pf-k">Mcap</span> <span className="pf-num">{usd(c.mcapUsd)}</span></span>
                  <span className="pf-meta"><span className="pf-k">24 h vol</span> <span className="pf-num">{usd(c.vol24Usd)}</span></span>
                  <span className="pf-meta"><span className="pf-k">{a.readOnly ? "Holds" : "You hold"}</span> <span className="pf-num" title={heldTitle(r)}>{heldText(r)}</span></span>
                  {r.claim && <Fee k={r.claim} label={name} a={a} />}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {g.rows.length > ROWS_MAX && (
        <button type="button" className="linkish pf-link pf-all" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${g.rows.length}`}<span className="sr-only"> pairs under {label}</span>
        </button>
      )}
      <div className="pf-links">
        <Link to={mapLink(p.mint)} className="pf-link">View on map</Link>
        {tracked && <Link to={`/launch?parent=${encodeURIComponent(p.mint)}`} className="pf-link">Launch a child</Link>}
      </div>
    </article>
  );
}
