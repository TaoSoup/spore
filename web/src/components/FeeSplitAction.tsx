// Lets a coin's creator lock the creator/Spore fee split on a coin that has none yet: a spawn whose
// second transaction did not land, or a child coin created elsewhere. Same shares as at spawn time
// (the server computes them). A locked split that names the Spore wallet is also what makes the
// coin "ours" in the listings (DESIGN §11.1).
//
// Who signs: the coin's creator, and nobody else. The transaction creates the fee-sharing config
// with `creator` as its signer and updates the shares with the creator as authority and current
// shareholder (lib/pump/spawn.ts buildFeeSplitTx), so the program refuses any other wallet. The
// card therefore shows only when one of the user's wallets IS the creator, and that wallet signs:
// the trading wallet (no popup, so it asks once more here, with the simulated cost), or the
// connected extension for a coin created with it, even when a trading wallet is the account.
import { useEffect, useRef, useState } from "react";
import { PublicKey, type VersionedTransaction } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import { api, solscanTx, type Coin, type Eligibility } from "../lib/api";
import { buildFeeSplitTx, sendAndConfirm } from "../lib/pump";
import { policyShares, preflightMeasured } from "../lib/flow";
import { friendlyError } from "../lib/steps";
import { feeSol, short } from "../lib/format";
import { openTradingWallet, useAccount } from "../lib/trader";
import SplitPreview from "./SplitPreview";
import { Ext } from "./Bits";
import { CHILD_SPLIT_YOU } from "../lib/copy";

export default function FeeSplitAction({ coin, onDone }: { coin: Coin; onDone: () => void }) {
  const { connection } = useConnection();
  const account = useAccount();
  // which of the user's wallets created the coin: that one signs, and its address takes the creator's share
  const own = account.walletOf(coin.creator);
  const me = own ? coin.creator : null;
  const silent = own === "trading";
  const locked = silent && account.locked;
  const sender = own === "trading" ? account.sender : own === "wallet" ? account.ext.sender : null;
  const [elig, setElig] = useState<Eligibility | null>(null);
  const [state, setState] = useState<{ busy: boolean; sig: string | null; error: string | null }>({ busy: false, sig: null, error: null });
  // the trading wallet's confirmation: the built transaction and what its simulation spends
  const [ask, setAsk] = useState<{ tx: VersionedTransaction; spent: bigint | null } | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const parent = coin.parent;
  const mine = !!me;

  useEffect(() => {
    if (!mine || !parent) { setElig(null); return; }
    let alive = true;
    api.eligibility(parent.mint, me).then((e) => { if (alive) setElig(e); }).catch(() => { if (alive) setElig(null); });
    return () => { alive = false; };
  }, [mine, parent, me]);

  if (!mine || !parent || coin.holderReward) return null;

  const fail = (e: unknown) => { if (alive.current) setState({ busy: false, sig: null, error: silent ? friendlyError(e) : e instanceof Error ? e.message : String(e) }); };
  const send = async (tx: VersionedTransaction) => {
    if (!sender) throw new Error(locked ? "The trading wallet is locked: unlock it first" : "Connect the wallet that created this coin first");
    if (!sender.publicKey?.equals(tx.message.staticAccountKeys[0])) throw new Error("Your wallet changed meanwhile. Nothing was signed; try again.");
    const sig = await sendAndConfirm(connection, sender, tx);
    if (alive.current) setState({ busy: false, sig, error: null });
    onDone();
  };
  const lock = async () => {
    if (locked) { openTradingWallet("unlock"); return; }
    if (!elig?.shares.length || !me) return;
    setState({ busy: true, sig: null, error: null });
    try {
      const creator = new PublicKey(me);
      const parentCoin = (await api.coin(parent.mint)).coin;
      const shares = policyShares(creator, elig); // pinned creator 50 / Spore 50; the server's copy must agree
      const tx = await buildFeeSplitTx(connection, creator, new PublicKey(coin.mint), new PublicKey(parent.mint), new PublicKey(parentCoin.tokenProgram), shares, coin.complete);
      // the extension shows the transaction and asks; the trading wallet does not, so the card asks, with the cost
      if (!silent) { await send(tx); return; }
      // only a measured cost is offered for a signature that no wallet popup follows (lib/flow.ts preflightMeasured)
      const pf = await preflightMeasured(connection, tx, creator, true);
      if (!alive.current) return;
      setAsk({ tx, spent: pf.spent });
      setState({ busy: false, sig: null, error: null });
    } catch (e) { fail(e); }
  };
  const confirm = async () => {
    if (!ask) return;
    const { tx } = ask;
    setAsk(null);
    setState({ busy: true, sig: null, error: null });
    try { await send(tx); } catch (e) { fail(e); }
  };

  return (
    <section className="card pad fee-lock">
      <span className="card-label">Your coin</span>
      <h3>Lock the fee split</h3>
      <p className="muted">This coin has no fee-sharing config yet, so all creator fees stay with you and the coin is not listed as a Spore launch. Locking writes the split on-chain: {CHILD_SPLIT_YOU}. It is set once; the admin is revoked, so it can never change.</p>
      {elig?.shares.length ? <SplitPreview shares={elig.shares} you={me} parentCreator={elig.parentCreator} grandparentCreator={elig.grandparentCreator} platform={elig.platform} parentSymbol={parent.symbol} grandparentSymbol={coin.ancestors[1]?.symbol ?? null} /> : <p className="muted">Computing the split…</p>}
      {own === "wallet" && account.kind === "trading" && <p className="hint">This coin was created with your connected wallet <span className="mono">{short(me, 4)}</span>. Only the creator can lock the split, so that wallet signs, and the creator's share goes to it, not to your trading wallet.</p>}
      {ask ? (
        <>
          <p className="hint" role="status">Simulated just now: locking spends <b className="mono">{ask.spent === null ? "—" : feeSol(ask.spent)}</b> from your trading wallet <span className="mono">{short(me, 4)}</span> and writes the split above. Your trading wallet signs when you press the button; no wallet popup follows.{account.unsaved ? " Its private key is not saved outside this browser yet: the creator's share is paid to this wallet for good, so save the key (trading wallet panel) before you rely on it." : ""}</p>
          <div className="confirm-actions">
            <button className="btn ghost" type="button" onClick={() => setAsk(null)}>Cancel</button>
            <button className="btn accent" type="button" disabled={ask.spent === null} onClick={confirm}>Lock the fee split now</button>
          </div>
        </>
      ) : (
        <button className="btn soft" type="button" disabled={state.busy || (!locked && !elig?.shares.length)} onClick={lock}>{state.busy ? (silent ? "Working…" : "Waiting for your wallet…") : locked ? "Unlock trading wallet to lock the split" : "Lock fee split"}</button>
      )}
      {state.sig && <p className="hint">Locked. <Ext href={solscanTx(state.sig)}>View transaction ↗</Ext></p>}
      {state.error && <p className="error">{state.error}</p>}
    </section>
  );
}
