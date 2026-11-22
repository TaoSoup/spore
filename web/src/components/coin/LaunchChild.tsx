// "Launch a child of $SYM" on the coin page: the shortest way to launch a coin priced in the coin being looked at. One
// link field fills the form (an X post link: name and ticker from its words, through GET /api/post-fill; the post
// link becomes the coin's X link), an image square, name and ticker, a dev buy in SOL, and one button. It runs the
// EXISTING launch flow unchanged (lib/flow.ts runSpawn: eligibility and the pinned fee policy, the metadata upload,
// the transaction build, the pre-flight simulation, the pending record saved before signing, the fee split, the first
// buy), with the account wallet the Launch page uses (lib/trader.ts useAccount): the trading wallet when there is one
// (Spore's own confirmation with the simulated cost, components/launch/LaunchAsk.tsx; no wallet popup), else the
// connected extension (its popup is the approval). The rules of each field are the Launch page's (lib/launch-form.ts).
// A locked trading wallet: the click opens the unlock and, once unlocked within 60 s with nothing changed, that launch
// goes ahead once (components/useUnlockContinuation.ts), still through the confirmation. One launch at a time
// (lib/pending-intent.ts InFlightLock, taken before anything is awaited).
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useConnection } from "@solana/wallet-adapter-react";
import { api, ApiError, type Coin } from "../../lib/api";
import { copyText, useAsync, useSolBalance } from "../../lib/hooks";
import { launchFeeOf, policyShares, runSpawn, walletSigner, type SpawnResult } from "../../lib/flow";
import { feeRole } from "../../lib/fee-roles";
import { lamportsToSol, parseAmount, short, sol } from "../../lib/format";
import { IMAGE_TYPES, normaliseSocial, prepareImage, type PreparedImage } from "../../lib/image";
import { nameFromPost, parseFillLink, tickerFromName } from "../../lib/launch-fill";
import { childCanBuy, launchErrors, sanitizeTicker, NAME_MAX, DESCRIPTION_MAX, type LaunchField } from "../../lib/launch-form";
import { INTENT_TTL_MS, InFlightLock, launchIntentKey } from "../../lib/pending-intent";
import { friendlyError, type Step } from "../../lib/steps";
import { openTradingWallet, useAccount } from "../../lib/trader";
import { EST_RENT_LAMPORTS, FEE_MARGIN_LAMPORTS, launchTotal } from "../CostBox";
import { launchBlock, Sprout } from "../LaunchButton";
import { useLaunchAsk } from "../launch/LaunchAsk";
import Steps from "../Steps";
import { sym } from "../Bits";
import { useToast } from "../Toast";
import { useUnlockContinuation } from "../useUnlockContinuation";

/// The dev buy choices, in SOL: a second transaction right after the launch, SOL → this coin's tree → the new coin.
const DEV_BUYS = ["0", "0.1", "0.5", "1"];
/// The first buy's slippage (the Launch page's default).
const DEV_BUY_SLIPPAGE_BPS = 300;
/// How long a pasted post is waited for (the server fetches post texts at a pace), and how often it is asked again.
const POST_WAIT_MS = 45_000, POST_POLL_MS = 3_000;
const ORDER: LaunchField[] = ["name", "symbol", "image", "description", "website", "twitter", "telegram"];

export type LaunchChildHandle = { focus: () => void };

type Props = { coin: Coin; maxDepth: number | undefined };

const LaunchChild = forwardRef<LaunchChildHandle, Props>(function LaunchChild({ coin, maxDepth }, ref) {
  const { connection } = useConnection();
  const account = useAccount();
  const toast = useToast();
  const parentTag = sym(coin);
  const block = launchBlock(coin, maxDepth);
  const linkRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  // eligibility is read once the card is used (not on every coin page view)
  const [armed, setArmed] = useState(false);
  useImperativeHandle(ref, () => ({ focus: () => { setArmed(true); cardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }); linkRef.current?.focus({ preventScroll: true }); } }), []);

  const [link, setLink] = useState("");
  const [fillNote, setFillNote] = useState<{ tone: "muted" | "warn"; text: string } | null>(null);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [image, setImage] = useState<PreparedImage | null>(null);
  const [imageErr, setImageErr] = useState<string | null>(null);
  const [devBuy, setDevBuy] = useState("0");
  const [more, setMore] = useState(false);
  const [description, setDescription] = useState("");
  const [website, setWebsite] = useState(""); const [twitter, setTwitter] = useState(""); const [telegram, setTelegram] = useState("");
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SpawnResult | null>(null);
  const lock = useRef(new InFlightLock()).current;
  // a new coin page is a new card
  useEffect(() => { setResult(null); setError(null); setSteps([]); setFillNote(null); }, [coin.mint]);

  const me = account.publicKey;
  const creator = me?.toBase58() ?? null;
  const elig = useAsync(() => (armed && !block ? api.eligibility(coin.mint, creator) : Promise.resolve(null)), [armed, block, coin.mint, creator]);
  const e = elig.data;
  const balance = useSolBalance(connection, me);
  const silent = account.kind === "trading";
  const signer = useMemo(() => (account.sender ? walletSigner(connection, account.sender, silent) : null), [connection, account.sender, silent]);
  const { confirmWith, dialog } = useLaunchAsk();

  const errors = launchErrors({ name, symbol, hasImage: !!image, description, twitter, telegram, website });
  const problem = ORDER.map((f) => errors[f]).find(Boolean) ?? null;
  let launchFee: ReturnType<typeof launchFeeOf> | null = null, policyProblem: string | null = null;
  try { launchFee = e ? launchFeeOf(e) : null; if (e && me) policyShares(me, e, null, "preview"); } catch (err) { policyProblem = err instanceof Error ? err.message : String(err); }
  const canBuy = !!e?.ok && childCanBuy(coin);
  const buyLamports = canBuy ? parseAmount(devBuy, 9) ?? 0n : 0n;
  const feeLamports = launchFee?.lamports ?? 0n;
  const total = launchTotal(feeLamports, buyLamports, 0n, EST_RENT_LAMPORTS);
  const insufficient = balance.lamports !== null && balance.lamports < total + FEE_MARGIN_LAMPORTS;
  const needBackup = account.kind === "trading" && !account.locked && account.unsaved;
  const eligibleNow = !!(e && e.ok && e.shares.length > 0 && creator) && !policyProblem;

  const form = () => ({ name: name.trim(), symbol, description: description.trim(), image: image?.dataUrl ?? "", twitter: normaliseSocial("twitter", twitter), telegram: normaliseSocial("telegram", telegram), website: normaliseSocial("website", website) });
  const keyNow = () => launchIntentKey({ name, symbol, image: image?.dataUrl ?? null, devBuy, description, website, twitter, telegram });
  const split = (e?.shares ?? []).map((s) => `${s.address ? feeRole(s.address, { me: creator, creator: creator ?? undefined, inferCreator: true }).label : "you"} ${s.bps / 100}%`).join(" · ");

  // What a launch that cannot go ahead says: never a silent stop (the continuation after an unlock included).
  const refuse = (why: string) => toast.info(`${why}. Nothing was signed.`);
  /// A launch whose eligibility check was still running when the remembered click came back after an unlock: it goes
  /// ahead once the check answers, if no field changed and within the minute (else it is dropped, with a message).
  const waitElig = useRef<{ key: string; until: number } | null>(null);

  async function go(from: "click" | "continue") {
    if (!image) { refuse("Add an image to launch"); return; }
    if (!signer) { refuse("No wallet can sign this launch right now"); return; }
    if (e && !e.ok) { refuse(e.reason || "This coin cannot be a parent right now"); return; }
    if (policyProblem) { refuse(policyProblem); return; }
    if (!e || !eligibleNow) {
      if (elig.loading && from === "continue") { waitElig.current = { key: keyNow(), until: Date.now() + INTENT_TTL_MS }; toast.info("Checking this launch: it goes on to its confirmation once the check answers."); return; }
      if (!elig.loading || from === "continue") refuse("This launch could not be checked yet; press launch again in a moment");
      return;
    }
    if (insufficient) { refuse(`Not enough SOL: about ${sol(lamportsToSol(total))} needed`); return; }
    // one launch at a time: taken before anything is awaited, so a double click (or the continuation after an unlock
    // beside a click) cannot start a second one
    if (!lock.take()) return;
    setBusy(true); setError(null); setResult(null); setSteps([]);
    const tag = `$${symbol}`;
    const payer = signer.publicKey.toBase58();
    try {
      const r = await runSpawn(connection, signer, {
        parent: coin, eligibility: e, firstBuyLamports: buyLamports, slippageBps: DEV_BUY_SLIPPAGE_BPS, form: form(),
        confirm: signer.silent && !signer.dry ? confirmWith({ tag, image: image.dataUrl, payer, root: false, parentTag, feeLamports, seedLamports: 0n, split, slippage: DEV_BUY_SLIPPAGE_BPS }) : undefined,
      }, setSteps);
      setResult(r);
      balance.refresh();
      if (r.split.done) toast.success(`${tag} is live under ${parentTag}`, { href: `https://solscan.io/tx/${r.sig}`, label: "transaction" });
      else toast.error(`${tag} was created but the fee split did not land. Finish it on the launch page.`);
      if (r.buyError) toast.error(`Launched, but the dev buy failed: ${friendlyError(new Error(r.buyError))}`);
    } catch (err) {
      // "No" at the confirmation is not an error: nothing was signed, the form is as it was
      if ((err as { name?: string } | null)?.name === "NotConfirmedError") setSteps([]);
      else setError(friendlyError(err));
    } finally { lock.release(); setBusy(false); }
  }
  // the launch clicked while the trading wallet was locked: once, after the unlock, if no field changed
  const cont = useUnlockContinuation<null>("launch", coin.mint, () => keyNow(), () => attempt("continue"));

  // The checks a click meets, shared by the click and the continuation after an unlock (the same messages, the backup
  // step included), then the launch.
  function attempt(from: "click" | "continue") {
    waitElig.current = null;
    if (block || busy || lock.held || result) { if (from === "continue") refuse(block ?? "The launch did not go ahead: another launch is running or done"); return; }
    if (problem) { if (from === "continue") refuse(problem); return; }
    if (!account.kind) { openTradingWallet(); toast.info("Set up a trading wallet, or connect a wallet, to launch."); return; }
    if (account.locked) {
      if (from === "continue") return;
      cont.remember(null, keyNow());
      openTradingWallet("unlock");
      toast.info("Unlock your trading wallet: this launch goes on to its confirmation once it is unlocked (within a minute, if nothing changes).");
      return;
    }
    if (needBackup) { openTradingWallet(); toast.info("Save your trading wallet's private key first: the coin's creator fees are paid to this wallet for good."); return; }
    void go(from);
  }
  // the eligibility check a continued launch waited for has answered
  useEffect(() => {
    const w = waitElig.current;
    if (!w || elig.loading) return;
    waitElig.current = null;
    if (Date.now() > w.until || w.key !== keyNow()) { refuse("The launch did not go ahead: something changed while it was checked"); return; }
    attempt("continue");
  });

  const press = (ev: FormEvent) => {
    ev.preventDefault();
    setArmed(true);
    attempt("click");
  };

  // ---- the link fill
  const fillSeq = useRef(0);
  const autoName = useRef(""), autoSym = useRef("");
  // the fields as they are now (a fill answers seconds after it started: what the user typed meanwhile stays)
  const nameRef = useRef(name), symRef = useRef(symbol);
  nameRef.current = name; symRef.current = symbol;
  // the link text the last fill started from: leaving the field does not start the same fill again
  const lastFill = useRef("");
  const fillFrom = async (raw: string) => {
    const l = parseFillLink(raw);
    lastFill.current = raw.trim();
    const n = ++fillSeq.current;
    if (!raw.trim()) { setFillNote(null); return; }
    if (l.kind === "none") { setFillNote({ tone: "warn", text: "Paste an x.com or twitter.com post link, or drop the image on the square." }); return; }
    if (l.kind === "image") { setFillNote({ tone: "warn", text: "Image links cannot be fetched here: save the image and drop or pick it on the square." }); return; }
    // the post's link rebuilt from its id: no share-tracking query (?s=..&t=..) goes into the coin's public metadata
    const postUrl = `https://x.com/i/status/${l.id}`;
    if (!twitter.trim()) setTwitter(postUrl);
    setFillNote({ tone: "muted", text: "Reading the post…" });
    const until = Date.now() + POST_WAIT_MS;
    for (;;) {
      let r;
      try { r = await api.postFill(postUrl); }
      catch (err) {
        if (n !== fillSeq.current) return;
        setFillNote({ tone: "warn", text: err instanceof ApiError && err.status === 404 ? "Spore does not read post texts right now. Type a name and ticker." : "The post could not be read just now. Type a name and ticker." });
        return;
      }
      if (n !== fillSeq.current) return;
      if (r.state === "ok") {
        const nm = nameFromPost(r.text, r.handle);
        const tk = tickerFromName(nm);
        // what the user typed stays; what an earlier fill put there is replaced
        const curName = nameRef.current, curSym = symRef.current;
        if (nm && (!curName.trim() || curName === autoName.current)) { setName(nm); autoName.current = nm; }
        if (tk && (!curSym || curSym === autoSym.current)) { setSymbol(tk); autoSym.current = tk; }
        setFillNote({ tone: "muted", text: `Filled from @${r.handle ?? "the post"}. X gives no image: add one on the square. Edit anything.` });
        return;
      }
      if (r.state === "none") { setFillNote({ tone: "warn", text: "X does not show this post. Type a name and ticker." }); return; }
      if (r.state === "idle" || Date.now() > until) { setFillNote({ tone: "warn", text: "The post is not readable right now (Spore reads posts at a set pace). Type a name and ticker, or paste it again later." }); return; }
      await new Promise((res) => setTimeout(res, POST_POLL_MS));
      if (n !== fillSeq.current) return;
    }
  };

  // ---- the image square
  const fileRef = useRef<HTMLInputElement>(null);
  const imgSeq = useRef(0);
  const take = async (file: File | null | undefined) => {
    if (!file) return;
    const n = ++imgSeq.current;
    setImageErr(null);
    try { const p = await prepareImage(file); if (n === imgSeq.current) setImage(p); }
    catch (err) { if (n === imgSeq.current) setImageErr(err instanceof Error ? err.message : String(err)); }
  };
  const onDrop = (ev: DragEvent) => { ev.preventDefault(); void take(ev.dataTransfer.files?.[0]); };
  // an image pasted into the link field is the coin's image
  const onLinkPaste = (ev: ClipboardEvent<HTMLInputElement>) => {
    const item = [...(ev.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
    if (item && !ev.clipboardData.getData("text/plain")) { ev.preventDefault(); void take(item.getAsFile()); return; }
    const text = ev.clipboardData.getData("text/plain");
    if (text) setTimeout(() => void fillFrom(text), 0);
  };

  // ---- the button's state, with its reason
  const tag = symbol ? `$${symbol}` : "$TICKER";
  // what is known while the trading wallet is locked (its address, balance and eligibility are public) is said before
  // the unlock: an unlock never leads to a "no" that could have been shown first
  const hardNo = block ? block
    : problem ? problem
    : e && !e.ok ? e.reason || "This coin cannot be a parent right now"
    : policyProblem ? policyProblem
    : insufficient ? `Not enough SOL: about ${sol(lamportsToSol(total))} needed`
    : null;
  const reason: string | null = hardNo ? hardNo
    : !account.kind ? "Set up a trading wallet or connect a wallet to launch"
    : account.locked ? null
    : needBackup ? null
    : !armed || (elig.loading && !e) ? "Checking this coin can take a child…"
    : elig.error && !e ? "Spore could not check this launch right now"
    : null;
  const actionable = !busy && !result && (account.locked || needBackup || !account.kind ? !hardNo : reason === null);
  const label = busy ? "Launching…" : account.locked && !hardNo ? `Unlock to launch ${tag}` : needBackup ? "Save your key to launch" : `Launch ${tag} under ${parentTag}`;

  return (
    <section ref={cardRef} id="launch-child" className="card coin-launch" aria-labelledby="launch-child-title" onFocusCapture={() => setArmed(true)}>
      <div className="cl-head">
        <h2 id="launch-child-title"><Sprout /> Launch a child of {parentTag}</h2>
        <p className="muted">Priced in {parentTag} · joins its tree</p>
      </div>
      {result ? (
        <div className="cl-done" role="status">
          <p><b>{`$${result.symbol}`}</b> {result.split.done ? `is live under ${parentTag}.` : "was created; its fee split still has to be locked."}</p>
          <p className="cl-addr"><Link to={`/c/${result.mint}`}>Open ${result.symbol} →</Link><button type="button" className="linkish mono" title="Copy the contract address" onClick={async () => { if (await copyText(result.mint)) toast.success("Contract address copied"); }}>{short(result.mint, 6)}</button></p>
          {!result.split.done && <p className="hint">Finish the fee split on the <Link to="/launch">launch page</Link>: it picks this launch up from this browser.</p>}
          {result.buyError && <p className="hint">The dev buy did not go through: {friendlyError(new Error(result.buyError))}</p>}
          <button type="button" className="btn sm ghost" onClick={() => { setResult(null); setName(""); setSymbol(""); setImage(null); setLink(""); setDevBuy("0"); setDescription(""); setTwitter(""); setWebsite(""); setTelegram(""); setFillNote(null); setSteps([]); }}>Launch another</button>
        </div>
      ) : (
        <form className="cl-form" onSubmit={press} noValidate>
          <label className="cl-link">
            <span className="sr-only">Paste a post or image link to fill everything</span>
            <input ref={linkRef} className="input" value={link} placeholder="Paste a post or image link to fill everything" autoComplete="off" spellCheck={false} disabled={busy}
              onChange={(ev) => setLink(ev.target.value)} onPaste={onLinkPaste} onBlur={() => { if (link.trim() && link.trim() !== lastFill.current) void fillFrom(link); }} />
          </label>
          {fillNote && <small className={`cl-fill ${fillNote.tone}`} role="status">{fillNote.text}</small>}
          <div className="cl-row">
            <button type="button" className={`cl-img ${image ? "has" : ""}`} aria-label={image ? "Replace the coin image" : "Choose the coin image"} title="Drop, pick or paste an image (png, jpg, webp, gif)" disabled={busy}
              onClick={() => fileRef.current?.click()} onDragOver={(ev) => ev.preventDefault()} onDrop={onDrop}>
              {image ? <img src={image.dataUrl} alt="" width={44} height={44} /> : <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="2" /><path d="M21 16l-5-5-8 8" /></svg>}
            </button>
            <input ref={fileRef} type="file" hidden accept={IMAGE_TYPES.join(",")} onChange={(ev) => { void take(ev.target.files?.[0]); ev.target.value = ""; }} />
            <input className="input cl-name" value={name} maxLength={NAME_MAX} placeholder="Name" aria-label="Name" autoComplete="off" disabled={busy} aria-invalid={!!(name && errors.name) || undefined} onChange={(ev) => setName(ev.target.value)} />
            <input className="input mono cl-sym" value={symbol} placeholder="TICKER" aria-label="Ticker" autoComplete="off" spellCheck={false} disabled={busy} aria-invalid={!!(symbol && errors.symbol) || undefined} onChange={(ev) => setSymbol(sanitizeTicker(ev.target.value))} />
          </div>
          {imageErr && <small className="field-error" role="alert">{imageErr}</small>}
          <div className="cl-buy">
            <span className="cl-k">Dev buy</span>
            {canBuy || !e ? (
              <span className="seg" role="group" aria-label="Dev buy, in SOL">
                {DEV_BUYS.map((v) => <button key={v} type="button" aria-pressed={devBuy === v} disabled={busy} onClick={() => setDevBuy(v)}>{v === "0" ? "none" : `${v} SOL`}</button>)}
              </span>
            ) : <small className="muted">Not available: this tree is not priced in SOL.</small>}
          </div>
          {buyLamports > 0n && <small className="muted cl-buy-note">A second signature right after the launch buys {tag} with {devBuy} SOL, through {parentTag}, up to {DEV_BUY_SLIPPAGE_BPS / 100}% slippage.</small>}
          <button type="button" className="linkish cl-more-toggle" aria-expanded={more} onClick={() => setMore((m) => !m)}>More options {more ? "▾" : "›"}</button>
          {more && (
            <div className="cl-more">
              <label className="field"><span>Description <small className="muted">{description.length}/{DESCRIPTION_MAX}</small></span><textarea className="textarea" value={description} maxLength={DESCRIPTION_MAX} disabled={busy} onChange={(ev) => setDescription(ev.target.value)} /></label>
              <label className="field"><span>Website</span><input className="input" value={website} maxLength={200} placeholder="https://…" disabled={busy} onChange={(ev) => setWebsite(ev.target.value)} onBlur={() => setWebsite((v) => normaliseSocial("website", v))} /></label>
              <label className="field"><span>X</span><input className="input" value={twitter} maxLength={120} placeholder="@handle or post link" disabled={busy} onChange={(ev) => setTwitter(ev.target.value)} onBlur={() => setTwitter((v) => normaliseSocial("twitter", v))} /></label>
              <label className="field"><span>Telegram</span><input className="input" value={telegram} maxLength={120} placeholder="t.me/…" disabled={busy} onChange={(ev) => setTelegram(ev.target.value)} onBlur={() => setTelegram((v) => normaliseSocial("telegram", v))} /></label>
              <Link to={`/launch?parent=${coin.mint}`} className="cl-full">Full launch form (creator fee, plan, rules) →</Link>
            </div>
          )}
          {error && <p className="notice bad compact" role="alert">The launch stopped: {error}</p>}
          {steps.length > 0 && <Steps steps={steps} title={busy ? "Launching" : "Stopped"} />}
          <button type="submit" className={`btn accent block cl-go ${busy ? "is-busy" : ""}`} disabled={!actionable} aria-describedby={reason ? "launch-child-why" : undefined}>{label}</button>
          {reason && !busy && <small id="launch-child-why" className="muted cl-why">{reason}{insufficient && silent && <> · <button type="button" className="linkish" onClick={() => openTradingWallet("deposit")}>Add SOL</button></>}</small>}
          {!reason && !busy && account.kind && <small className="muted cl-why">{silent ? `Launches as your trading wallet ${short(creator, 4)}: simulated first, then you confirm the exact cost.` : "Simulated first; your wallet shows the exact cost."}{launchFee && launchFee.lamports > 0n ? ` Launch fee ${sol(lamportsToSol(launchFee.lamports))}.` : ""}</small>}
        </form>
      )}
      {dialog}
    </section>
  );
});

export default LaunchChild;
