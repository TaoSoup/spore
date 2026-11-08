import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { api, type Coin } from "../lib/api";
import { useAsync, useDebounced, useMediaQuery, useSolBalance, useStats } from "../lib/hooks";
import { QUOTE_PROBE, drySigner, finishFeeSplit, launchFeeOf, policyShares, runSpawn, spawnPlan, walletSigner, type Signer, type SpawnResult } from "../lib/flow";
import { AGENT_MODELS, AGENT_SEED_LAMPORTS, DEFAULT_AGENT_MODEL, ROOT_SPLIT, SPLIT_BPS, type AgentModelId } from "../lib/policy";
import { failedBeforeSigning, friendlyError, type Step } from "../lib/steps";
import { chainFor } from "../lib/chain";
import { estimateFirstBuy } from "../lib/pump";
import { isHttpUrl, normaliseSocial, type PreparedImage } from "../lib/image";
import { clearPending, loadPending, type PendingLaunch } from "../lib/launch-store";
import { dryWallet, isDry } from "../lib/dry";
import { CHILD_SPLIT_YOU, NON_CUSTODIAL, NO_LAUNCH_FEE, ROOT_SPLIT_YOU, SPORE_BUYBACK, TRUST_POINTS } from "../lib/copy";
import { feeRole, type FeeRoleTone } from "../lib/fee-roles";
import { compact, lamportsToSol, parseAmount, sol, usd } from "../lib/format";
import Steps from "../components/Steps";
import SplitPreview from "../components/SplitPreview";
import CostBox, { EST_RENT_LAMPORTS, FEE_MARGIN_LAMPORTS, launchTotal, simulatedRent, type BuyEstimate } from "../components/CostBox";
import SporeCanvas, { motionPaused } from "../components/SporeCanvas";
import Term from "../components/Term";
import ImageField from "../components/launch/ImageField";
import LaunchSuccess from "../components/launch/LaunchSuccess";
import ResumeCard from "../components/launch/ResumeCard";
import TreeChoice, { type Tree } from "../components/launch/TreeChoice";
import AgentSetup from "../components/launch/AgentSetup";
import LaunchBar from "../components/launch/LaunchBar";
import Certificate from "../components/launch/Certificate";
import { ProgressArc, RailGlyph, type GlyphState } from "../components/launch/art";
import { Chip, DepthBadge, Skeleton, sym, useTint } from "../components/Bits";
import { useToast } from "../components/Toast";
import "../components/launch.css";

const SLIPPAGES = [100, 200, 300, 500];
const QUICK_BUYS = ["0.1", "0.25", "0.5", "1"];
const TICKER_RE = /^[A-Z0-9]{1,13}$/;
type Field = "name" | "symbol" | "description" | "image" | "twitter" | "telegram" | "website" | "firstBuy" | "feeBps";
/// Form order: the first invalid field in this order is where a blocked launch takes the visitor.
const FIELD_ORDER: Field[] = ["name", "symbol", "description", "twitter", "telegram", "website", "image", "firstBuy", "feeBps"];
const SOCIALS = ["twitter", "telegram", "website"] as const;
const ROLE_CLASS: Record<FeeRoleTone, string> = { you: "role-creator", creator: "role-creator", spore: "role-spore", agent: "role-agent", other: "role-other" };

/// What each launch step will do, shown in the plan before anything runs.
const PLAN_DETAIL: Record<string, string> = {
  agent: "Spore makes a fresh wallet for your coin's agent; its address goes into the fee split.",
  upload: "Your image and text are published to Spore's host.",
  build: "One transaction creates the coin and locks the fee split.",
  preflight: "It runs on a copy of the chain first; a problem stops here, before your wallet opens.",
  sign: "You approve in your wallet; the page follows it until it confirms.",
  split: "Usually inside the same transaction; a deep tree needs a second signature.",
  quote: "Your first buy is quoted on the new curve.",
  buy: "A second signature buys your first tokens.",
};

/// A persisted launch as a result the success screen can show (and finish). The signature is empty
/// for a launch recovered from the chain (the wallet never returned one); the screen hides its link.
const resultFromPending = (p: PendingLaunch): SpawnResult => ({
  sig: p.sig ?? "", mint: p.mint, depth: p.depth, name: p.name, symbol: p.symbol, image: p.image,
  parent: p.parentMint ? { mint: p.parentMint, symbol: p.parentSymbol } : null,
  split: { done: p.step === "done", sig: p.splitSig, error: null }, buy: null, buyError: null, spent: null, dry: false, pending: p, agent: p.agent ?? null,
});
const roundUsd = (n: number) => (n >= 10 ? `$${Math.round(n).toLocaleString("en-US")}` : usd(n));
const scrollTo = (el: Element | null | undefined, block: ScrollLogicalPosition = "start") => el?.scrollIntoView({ behavior: motionPaused() ? "auto" : "smooth", block });

/// A step panel's serif numeral; a done step turns it lime and adds a drawn check.
const StepN = ({ n, done }: { n: string; done: boolean }) => (
  <i className={`numeral step-n ${done ? "is-done" : ""}`} aria-hidden="true">{n}{done && <svg viewBox="0 0 16 16" width="14" height="14"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>}</i>
);

/// The launch form. A new tree (a root priced in SOL, with its own AI agent) by default;
/// `?parent=<mint>` grows the tree under any pump.fun coin instead. Served at /launch and /spawn.
export default function Launch() {
  const [params, setParams] = useSearchParams();
  const parentMint = params.get("parent") || "";
  const { connection } = useConnection();
  const wallet = useWallet();
  const toast = useToast();
  const { stats } = useStats();
  // Dev-only dry run (`?dry=1`): a wallet shim replaces wallet-adapter and every send is a
  // simulation. `isDry()` is false in production builds whatever the URL says.
  const dry = isDry();
  const dryW = useMemo(() => (dry ? dryWallet() : null), [dry]);
  const signer: Signer | null = useMemo(() => (dryW ? drySigner(connection, dryW) : walletSigner(connection, wallet)), [connection, dryW, wallet]);
  const connected = !!signer;
  const creator = signer?.publicKey.toBase58() ?? null;
  const balance = useSolBalance(connection, signer?.publicKey ?? null);
  const narrow = useMediaQuery("(max-width: 560px)");
  // "Grow an existing tree" chosen, parent not picked yet; `picking` = the search is open over a chosen parent.
  const [growing, setGrowing] = useState(false);
  const [picking, setPicking] = useState(false);
  useEffect(() => { document.title = "Launch · Spore"; return () => { document.title = "Spore"; }; }, []);
  // Changing the tree is a navigation (the `?parent=` contract), which the shell answers by
  // scrolling to the top; the visitor stays where they were instead (restored after that).
  const keepY = useRef<number | null>(null);
  const setPool = (mint: string | null) => { keepY.current = window.scrollY; setParams(mint ? (dry ? { parent: mint, dry: "1" } : { parent: mint }) : (dry ? { dry: "1" } : {})); };
  useEffect(() => { if (keepY.current === null) return; const y = keepY.current; keepY.current = null; window.scrollTo({ top: y, behavior: "instant" }); }, [parentMint]);

  const tree: Tree = parentMint || growing ? "child" : "root";
  const isRoot = tree === "root";
  const parent = useAsync(() => (parentMint ? api.coin(parentMint).then((r) => r.coin) : Promise.resolve<Coin | null>(null)), [parentMint]);
  // Eligibility is re-fetched with the connected wallet so the server merges duplicate shares
  // (self-launch, platform-owned parent); the shares it returns are exactly what gets signed.
  // The SOL pool has its own endpoint: no parent to check, same split and launch fee.
  const elig = useAsync(() => (parentMint ? api.eligibility(parentMint, creator) : api.eligibilitySol(creator)), [parentMint, creator]);

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [twitter, setTwitter] = useState(""); const [telegram, setTelegram] = useState(""); const [website, setWebsite] = useState("");
  const [linksOpen, setLinksOpen] = useState(false);
  const [image, setImage] = useState<PreparedImage | null>(null);
  const [firstBuy, setFirstBuy] = useState("");
  const [slippage, setSlippage] = useState(300);
  const [feeBps, setFeeBps] = useState("");
  // A root's agent thinks with the model its creator picks here (lib/policy.ts AGENT_MODELS).
  const [model, setModel] = useState<AgentModelId>(DEFAULT_AGENT_MODEL);
  const [advanced, setAdvanced] = useState(false);
  const [touched, setTouched] = useState<Set<Field>>(new Set());
  const [tried, setTried] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const lastSteps = useRef<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SpawnResult | null>(null);
  const [error, setError] = useState<{ text: string; beforeSigning: boolean } | null>(null);
  // Rent + network fees as the pre-flight simulation measured them (replaces the ~estimate).
  const [simRent, setSimRent] = useState<bigint | null>(null);
  // The fee-split retry (success screen / resume card) has its own step list.
  const [splitSteps, setSplitSteps] = useState<Step[]>([]);
  const [splitBusy, setSplitBusy] = useState(false);
  const [splitError, setSplitError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingLaunch | null>(() => loadPending());
  const launchCard = useRef<HTMLElement>(null);
  const successCard = useRef<HTMLElement>(null);
  useEffect(() => { setResult(null); setSteps([]); setError(null); setPicking(false); setSimRent(null); if (parentMint) setGrowing(false); }, [parentMint]);

  const touch = (f: Field) => setTouched((t) => (t.has(f) ? t : new Set(t).add(f)));
  const show = (f: Field) => tried || touched.has(f);
  const buyLamports = useMemo(() => parseAmount(firstBuy, 9) ?? 0n, [firstBuy]);
  const feeValue = !isRoot && feeBps.trim() !== "" ? Number(feeBps) : undefined;
  const socialBad = (kind: "twitter" | "telegram" | "website", v: string) => v.trim() !== "" && !isHttpUrl(normaliseSocial(kind, v));
  // One sentence per field, shown inline once the field was touched (or a launch was attempted).
  const errors: Partial<Record<Field, string>> = {
    ...(!name.trim() ? { name: "Give the coin a name (1–32 characters)" } : name.trim().length > 32 ? { name: "At most 32 characters" } : {}),
    ...(!symbol ? { symbol: "Pick a ticker: 1–13 letters or digits" } : !TICKER_RE.test(symbol) ? { symbol: "Letters and digits only, up to 13" } : {}),
    ...(!image ? { image: "Add an image: the coin's face on every card" } : {}),
    ...(description.length > 400 ? { description: "At most 400 characters" } : {}),
    ...(socialBad("twitter", twitter) ? { twitter: "A profile link or handle, like @spore" } : {}),
    ...(socialBad("telegram", telegram) ? { telegram: "A t.me link or handle" } : {}),
    ...(socialBad("website", website) ? { website: "A full URL, like https://example.com" } : {}),
    ...(firstBuy.trim() && buyLamports === 0n ? { firstBuy: "A SOL amount, or leave it empty" } : {}),
    ...(feeValue !== undefined && (!Number.isInteger(feeValue) || feeValue < 0 || feeValue > 300) ? { feeBps: "0–300 bps, or leave it empty" } : {}),
  };
  const problems = FIELD_ORDER.filter((f) => errors[f]);
  const p = parentMint ? parent.data : null;
  // A child with no parent picked yet has no eligibility of its own (the loaded one is the SOL pool's).
  const e = !isRoot && !parentMint ? null : elig.data;
  const poolReady = isRoot || !!p;
  // New trees need an agent wallet; a server that cannot make one pauses them (children still work).
  const agentPaused = isRoot && e?.agent?.ready === false;
  // Launch fee from the server, checked against the pinned policy (lib/policy.ts); a violation blocks the launch.
  let launchFee: ReturnType<typeof launchFeeOf> = null, policyProblem: string | null = null;
  try { launchFee = e ? launchFeeOf(e) : null; if (e && signer) policyShares(signer.publicKey, e, null, "preview"); } catch (err) { policyProblem = err instanceof Error ? err.message : String(err); }
  const eligibleNow = !!(poolReady && e && e.ok && e.shares.length > 0 && creator) && !policyProblem && !agentPaused;
  // A first buy from SOL needs a SOL-rooted chain: always true for a root, true for a child of one.
  const canBuy = !!(e?.ok && poolReady && (isRoot || (p!.depth === 0 ? p!.quoteMint === null : true)));
  const newDepth = isRoot ? 0 : p ? p.depth + 1 : (e?.depth ?? 1);
  const maxDepth = stats?.maxDepth ?? null;
  const feeLamports = launchFee?.lamports ?? 0n;
  const buyCost = canBuy ? buyLamports : 0n;
  // A root also seeds its agent wallet (lib/policy.ts AGENT_SEED_LAMPORTS) inside the same signature.
  const seedLamports = isRoot ? AGENT_SEED_LAMPORTS : 0n;
  const total = launchTotal(feeLamports, buyCost, seedLamports, simRent ?? EST_RENT_LAMPORTS);
  const insufficient = balance.lamports !== null && balance.lamports < total + FEE_MARGIN_LAMPORTS;
  // Progress rail: tree settled and eligible → coin described → launched.
  const step1 = !!(poolReady && e?.ok && !agentPaused);
  const step2 = !!(name.trim() && TICKER_RE.test(symbol) && image && description.length <= 400);
  const step3 = !!result;
  const [previewTint, onPreviewImg] = useTint(image?.dataUrl || null, symbol || name || "spore");
  const modelLabel = AGENT_MODELS.find((m) => m.id === model)?.label ?? model;
  // SOL → $ROOT → … → $PARENT → your coin, for the preview's route sentence.
  const route = p ? [...p.ancestors].reverse().map((a) => sym(a)).concat(sym(p)) : [];
  const parentTag = p ? sym(p) : "the parent";
  const tag = symbol ? `$${symbol}` : "$TICKER";

  // Social links fold behind "+ Add links" on narrow phones; a value or an error keeps them open.
  const socialValue = { twitter, telegram, website };
  const linksShown = !narrow || linksOpen || SOCIALS.some((f) => socialValue[f].trim() !== "" || (show(f) && errors[f]));


  // First-buy estimate from pump's curve math (the curve does not exist yet), debounced on the amount.
  const parentChain = useAsync(() => (p ? chainFor(p) : Promise.resolve(null)), [p?.mint ?? null]);
  const dBuy = useDebounced(canBuy ? buyLamports : 0n, 500);
  const estimateKey = `${dBuy}|${parentMint}|${feeValue ?? ""}|${parentChain.data ? "c" : "n"}`;
  const estimate = useAsync(async () => {
    if (dBuy <= 0n || (p && !parentChain.data)) return null;
    return estimateFirstBuy(connection, signer?.publicKey ?? QUOTE_PROBE, p ? new PublicKey(p.mint) : null, parentChain.data, dBuy, feeValue && !errors.feeBps ? feeValue : undefined);
  }, [estimateKey]);
  const buyEstimate: BuyEstimate | null = dBuy > 0n ? { tokens: estimate.data?.tokens ?? null, symbol, loading: estimate.loading || dBuy !== buyLamports, error: estimate.error ? "could not quote yet" : null, hops: estimate.data?.hops ?? 0 } : null;
  const buyUsd = stats?.solUsd && buyLamports > 0n ? (Number(buyLamports) / 1e9) * stats.solUsd : null;

  // The split as role segments, for the preview card and the phone summary: the server's shares
  // once loaded (they are what gets signed), the pinned policy before that.
  const segments: { key: string; bps: number; cls: string; label: string }[] = useMemo(() => {
    if (e && e.shares.length) {
      const segs = e.shares.map((s) => {
        const r = s.address ? feeRole(s.address, { me: creator, creator: creator ?? undefined, inferCreator: true }) : { label: "you", tone: "creator" as FeeRoleTone };
        return { key: s.address || "creator", bps: s.bps, cls: ROLE_CLASS[r.tone], label: r.label };
      });
      if (isRoot && e.agent?.bps) segs.push({ key: "agent", bps: e.agent.bps, cls: ROLE_CLASS.agent, label: "your coin's agent" });
      return segs.sort((a, b) => Number(b.cls === "role-creator") - Number(a.cls === "role-creator"));
    }
    return isRoot
      ? [{ key: "c", bps: ROOT_SPLIT.creator, cls: ROLE_CLASS.creator, label: "you" }, { key: "s", bps: ROOT_SPLIT.platform, cls: ROLE_CLASS.spore, label: "Spore" }, { key: "a", bps: ROOT_SPLIT.agent, cls: ROLE_CLASS.agent, label: "your coin's agent" }]
      : [{ key: "c", bps: SPLIT_BPS[0], cls: ROLE_CLASS.creator, label: "you" }, { key: "s", bps: SPLIT_BPS[3], cls: ROLE_CLASS.spore, label: "Spore" }];
  }, [e, creator, isRoot]);
  const splitBar = <div className="split-bar" aria-hidden="true">{segments.map((s) => <i key={s.key} className={s.cls} style={{ width: `${s.bps / 100}%` }} title={`${s.label} ${s.bps / 100}%`} />)}</div>;

  const planSteps: Step[] = spawnPlan({ prepareAgent: isRoot, agentModelLabel: isRoot ? modelLabel : null, launchFeeLamports: feeLamports, seedLamports, wantsBuy: canBuy && buyLamports > 0n })
    .map(([key, label]) => ({ key, label, state: "todo", detail: PLAN_DETAIL[key] }));

  const report = (s: Step[]) => { lastSteps.current = s; setSteps(s); };
  const focusFirstInvalid = () => {
    // After the render that opened anything folded (social links), not before.
    setTimeout(() => {
      const f = FIELD_ORDER.find((k) => errors[k]);
      const box = f ? document.querySelector<HTMLElement>(`[data-field="${f}"]`) : null;
      if (!box) return;
      scrollTo(box, "center");
      box.querySelector<HTMLElement>("input:not([type=file]), textarea, .dropzone")?.focus({ preventScroll: true });
    }, 30);
  };

  async function go() {
    setTried(true);
    if (problems.length) { focusFirstInvalid(); return; }
    if (!e || !eligibleNow || !signer || !image) return;
    setBusy(true); setError(null); setResult(null); lastSteps.current = []; setSteps([]);
    const form = { name: name.trim(), symbol, description: description.trim(), image: image.dataUrl, twitter: normaliseSocial("twitter", twitter), telegram: normaliseSocial("telegram", telegram), website: normaliseSocial("website", website) };
    const me = signer.publicKey.toBase58();
    try {
      // A root gets its agent wallet first (the flow's first step): the server makes the keypair,
      // keeps the key, and the address goes into the fee split the wallet signs.
      const r = await runSpawn(connection, signer, {
        parent: isRoot ? null : p, eligibility: e, firstBuyLamports: canBuy ? buyLamports : 0n, slippageBps: slippage, creatorFeeBps: feeValue || undefined, form,
        prepareAgent: isRoot ? async () => { const a = await api.agentPrepare(me, model); return { id: a.id, address: a.address, model: a.model }; } : undefined,
        agentModelLabel: isRoot ? modelLabel : undefined,
        onPreflight: (spent) => setSimRent(simulatedRent(spent, feeLamports, seedLamports)),
      }, report);
      setResult(r);
      setPending(null);
      balance.refresh();
      if (r.split.done) toast.success(isRoot ? `$${symbol} is live, priced in SOL` : `$${symbol} is live under ${sym(p)}`, r.dry ? undefined : { href: `https://solscan.io/tx/${r.sig}`, label: "transaction" });
      else toast.error(`$${symbol} was created but the fee split did not land. Finish it below.`);
      if (r.buyError) toast.error(`Launched, but the first buy failed: ${friendlyError(new Error(r.buyError))}`);
      setTimeout(() => scrollTo(successCard.current), 60);
    } catch (err) { setError({ text: friendlyError(err), beforeSigning: failedBeforeSigning(lastSteps.current) }); }
    finally { setBusy(false); setPending(loadPending()); }
  }

  /// Retries only the fee split of a launch whose create landed (from the success screen or the
  /// resume card): no upload, no new mint, one signature.
  async function finishSplit(rec: PendingLaunch) {
    if (!signer) { toast.error("Connect the wallet that launched the coin first"); return; }
    setSplitBusy(true); setSplitError(null); setSplitSteps([]);
    try {
      const sig = await finishFeeSplit(connection, signer, rec, setSplitSteps);
      setResult((r) => ({ ...(r ?? resultFromPending(rec)), split: { done: true, sig, error: null } }));
      setPending(null);
      toast.success("Fee split locked. Spore lists the coin once the indexer sees it.");
    } catch (err) { setSplitError(friendlyError(err)); }
    finally { setSplitBusy(false); }
  }

  const launchAnother = () => { setResult(null); setSteps([]); setError(null); setName(""); setSymbol(""); setDescription(""); setImage(null); setFirstBuy(""); setTried(false); setTouched(new Set()); setSimRent(null); setTimeout(() => window.scrollTo({ top: 0, behavior: motionPaused() ? "auto" : "smooth" }), 30); };
  const chooseTree = (t: Tree) => {
    if (t === "root") { setGrowing(false); setPicking(false); if (parentMint) setPool(null); }
    else { setGrowing(true); if (parentMint) setPicking(true); }
  };

  // From the paused notice: open the parent search and put the cursor in it.
  const pickParent = () => {
    chooseTree("child");
    setTimeout(() => { const i = document.querySelector<HTMLInputElement>(".tree-search input"); if (i) { scrollTo(i, "center"); i.focus({ preventScroll: true }); } }, 60);
  };

  const launchLabel = busy ? "Launching…" : agentPaused ? "New trees paused" : !poolReady ? "Pick a parent first" : insufficient ? "Not enough SOL" : isRoot ? `Launch ${symbol ? `$${symbol}` : "coin"} with SOL` : `Launch ${symbol ? `$${symbol}` : "coin"} under ${sym(p)}`;
  const launchDisabled = busy || !eligibleNow || insufficient || (tried && problems.length > 0);
  const err = (f: Field) => (show(f) && errors[f] ? <span className="field-error" role="alert">{errors[f]}</span> : null);
  const invalid = (f: Field) => (show(f) && errors[f] ? "invalid" : "");
  const locked = busy || !!result;
  const stepsDone = steps.filter((x) => x.state === "done").length;
  const glyph = (done: boolean, active: boolean): GlyphState => (done ? "done" : active ? "active" : "todo");
  const rail: { k: "tree" | "coin" | "launch"; n: string; label: string; state: GlyphState; current: boolean; note: string; target: string }[] = [
    { k: "tree", n: "01", label: "Tree", state: glyph(step1, true), current: !step1, note: isRoot ? "new tree · SOL" : p ? `under ${sym(p)}` : "pick a parent", target: "launch-tree" },
    { k: "coin", n: "02", label: "Your coin", state: glyph(step2, step1), current: step1 && !step2, note: step2 ? tag : "name · ticker · image", target: "launch-coin" },
    { k: "launch", n: "03", label: "Launch", state: glyph(step3, step1 && step2), current: step1 && step2 && !step3, note: busy ? (steps.length ? `launching · ${stepsDone}/${steps.length}` : "launching") : result ? (result.dry ? "dry run done" : "live") : `≈ ${sol(lamportsToSol(total))}`, target: "launch-go" },
  ];

  return (
    <>
      <SporeCanvas density={0.5} />
      <div className="container spawn launch-v2">
        <div className="page-head launch-head">
          <span className="eyebrow">Launch{dry && <Chip tone="warn" title="Development only: every transaction is simulated, nothing is sent">dry run</Chip>}</span>
          <h1>{isRoot ? <>Launch a coin. <em>Start</em> a tree.</> : p ? <>Launch a coin under <em>{sym(p)}</em>.</> : <>Grow an <em>existing</em> tree.</>}</h1>
          <p className="lead">{isRoot
            ? `A plain pump.fun coin priced in SOL, in one signature. ${NO_LAUNCH_FEE} Creator fees: ${ROOT_SPLIT_YOU}. ${SPORE_BUYBACK} Nothing custodial.`
            : `Your coin is priced in ${parentTag}, so every buy of it buys ${parentTag} first. Creator fees: ${CHILD_SPLIT_YOU}. No launch fee, one signature, nothing custodial.`}</p>
          <ul className="trust-row" aria-label="What you can count on">{TRUST_POINTS.map((t) => <li key={t}><i aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></i>{t}</li>)}</ul>
        </div>

        <div className="spawn-grid">
          <nav className="launch-rail" aria-label="Launch steps">
            <ol className="spawn-progress" aria-label="Progress" style={{ "--fill": step3 || (step1 && step2) ? 1 : step1 ? 0.5 : 0 } as CSSProperties}>
              {rail.map((r) => (
                <li key={r.k} className={r.state === "todo" ? "" : r.state} aria-current={r.current ? "step" : undefined}>
                  <button type="button" className="rail-step" aria-label={`Step ${Number(r.n)}, ${r.label}: ${r.note}`} onClick={() => scrollTo(document.getElementById(r.target) ?? successCard.current)}>
                    <span className="rail-mark"><RailGlyph k={r.k} state={r.state} /></span>
                    <span className="rail-text"><em><i className="rail-n">{r.n}</i> {r.label}</em><small className="mono">{r.note}</small></span>
                  </button>
                </li>
              ))}
            </ol>
          </nav>
          <div className="spawn-main">
            {pending && !result && <ResumeCard conn={connection} pending={pending} onResume={(rec) => { setResult(resultFromPending(rec)); void finishSplit(rec); setTimeout(() => scrollTo(successCard.current), 60); }} onDismiss={() => { clearPending(); setPending(null); }} />}


            {result && (
              <section ref={successCard} className="card raised success-card" aria-label="Launched">
                <LaunchSuccess r={result} segments={segments} parentImage={p?.image ?? null} maxDepth={maxDepth ?? undefined} onFinishSplit={() => void finishSplit(result.pending)} splitBusy={splitBusy} splitSteps={splitSteps} splitError={splitError} />
              </section>
            )}
            {result && (
              <div className="launch-done-row">
                {result.image ? <img src={result.image} alt="" width={32} height={32} /> : <span className="launch-done-letter" aria-hidden="true">{result.symbol.slice(0, 1)}</span>}
                <span className="launch-done-text">{result.name} · <b className="mono">${result.symbol}</b> · {result.parent ? `under $${result.parent.symbol ?? result.parent.mint.slice(0, 4)}` : "new tree"} · depth {result.depth}</span>
                <button type="button" className="btn sm ghost" onClick={launchAnother}>Launch another</button>
              </div>
            )}
            {result && steps.length > 0 && <details className="steps-details"><summary>What happened</summary><Steps steps={steps} /></details>}

            {!result && <>
              {/* Step 1: where the coin grows. A new tree (SOL, with an agent) or under a parent. */}
              <section id="launch-tree" className={`card raised step-card tree-card ${step1 ? "done" : ""} ${locked ? "locked" : ""}`}>
                <div className="step-head"><StepN n="01" done={step1} /><h2>Where your coin grows</h2>
                  <span className="step-status">
                    {!isRoot && !parentMint ? null
                      : elig.loading && !e ? <Skeleton w={64} h={22} r={11} />
                      : elig.error && !e ? <Chip tone="bad">eligibility unknown</Chip>
                      : agentPaused ? <Chip tone="warn">paused</Chip>
                      : e?.ok ? <Chip tone="good" title={isRoot ? "a new tree at depth 0" : `your coin at depth ${e.depth ?? newDepth}`}>Ready</Chip>
                      : e ? <Chip tone="bad">not eligible</Chip> : null}
                  </span>
                </div>
                <TreeChoice tree={tree} parent={p} parentLoading={!!parentMint && parent.loading} parentError={parentMint ? parent.error : null} reloadParent={parent.reload}
                  onChoose={chooseTree} onPickParent={(c) => setPool(c.mint)} picking={picking} setPicking={setPicking} maxDepth={maxDepth} locked={locked} agentPaused={agentPaused} />
                {agentPaused && (
                  <div className="notice warn agent-paused" role="status">
                    <span>New trees are paused for a moment: Spore can't create agent wallets right now. Your form is kept. You can still launch under an existing coin.</span>
                    <button type="button" className="btn sm ghost" onClick={pickParent}>Pick a parent</button>
                  </div>
                )}
                {isRoot && elig.error && !e && !elig.loading && <div className="notice bad"><span>Spore could not check this launch right now.</span><button type="button" className="btn sm ghost" onClick={elig.reload}>Retry</button></div>}
                {poolReady && e && !e.ok && <div className="notice bad"><span>{e.reason || "This coin cannot be a parent right now."}{maxDepth != null && <> pump.fun's depth limit is {maxDepth} levels under a root.</>}</span>{!isRoot && <button type="button" className="btn sm ghost" onClick={() => chooseTree("root")}>Start a new tree instead</button>}</div>}
                {!isRoot && p && !canBuy && e?.ok && <div className="notice warn">This tree is not rooted in SOL, so a first buy from SOL is not possible here; the launch itself works.</div>}
              </section>

              {/* Step 2: the coin itself, and a root's agent. */}
              <section id="launch-coin" className={`card raised step-card coin-card-step ${step2 ? "done" : ""} ${locked ? "locked" : ""}`}>
                <div className="step-head"><StepN n="02" done={step2} /><h2>Your coin</h2>{isRoot && <span className="step-status"><span className="label">with its own agent</span></span>}</div>
                <div className="grid-2">
                  <label className={`field ${invalid("name")}`} data-field="name"><span>Name <small className="muted">{name.length}/32</small></span><input className="input" value={name} maxLength={32} onChange={(ev) => setName(ev.target.value)} onBlur={() => touch("name")} placeholder="Little Pepe" autoComplete="off" />{err("name")}</label>
                  <label className={`field ${invalid("symbol")}`} data-field="symbol"><span>Ticker <small className="muted">letters and digits · shown as ${symbol || "TICKER"}</small></span><input className="input mono" value={symbol} onChange={(ev) => setSymbol(ev.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 13))} onBlur={() => touch("symbol")} placeholder="LILPEPE" autoComplete="off" spellCheck={false} />{err("symbol")}
                  </label>
                </div>
                <label className={`field ${invalid("description")}`} data-field="description"><span>Description <small className={`muted ${description.length > 360 ? "warn" : ""}`}>{description.length}/400</small></span><textarea className="textarea" value={description} maxLength={400} onChange={(ev) => setDescription(ev.target.value)} onBlur={() => touch("description")} placeholder={isRoot ? "What is this coin about? Your agent reads this to theme the coins it launches." : p ? `Why ${sym(p)} deserves a child.` : "What is this coin about?"} />{err("description")}</label>
                <div className={`links ${linksShown ? "open" : "folded"}`}>
                  {!linksShown && <button type="button" className="linkish links-toggle" aria-expanded={false} onClick={() => setLinksOpen(true)}>+ Add links (optional)</button>}
                  <div className="grid-3 links-grid">
                    <label className={`field ${invalid("twitter")}`} data-field="twitter"><span>X / Twitter <small className="muted">handle or link</small></span><input className="input" value={twitter} maxLength={120} onChange={(ev) => setTwitter(ev.target.value)} onBlur={() => { touch("twitter"); setTwitter((v) => normaliseSocial("twitter", v)); }} placeholder="@handle" autoComplete="off" />{err("twitter")}</label>
                    <label className={`field ${invalid("telegram")}`} data-field="telegram"><span>Telegram <small className="muted">handle or link</small></span><input className="input" value={telegram} maxLength={120} onChange={(ev) => setTelegram(ev.target.value)} onBlur={() => { touch("telegram"); setTelegram((v) => normaliseSocial("telegram", v)); }} placeholder="t.me/…" autoComplete="off" />{err("telegram")}</label>
                    <label className={`field ${invalid("website")}`} data-field="website"><span>Website</span><input className="input" value={website} maxLength={200} onChange={(ev) => setWebsite(ev.target.value)} onBlur={() => { touch("website"); setWebsite((v) => normaliseSocial("website", v)); }} placeholder="https://…" autoComplete="off" />{err("website")}</label>
                  </div>
                </div>
                <div className={`field ${invalid("image")}`} data-field="image"><span>Image <small className="muted">square · 512×512 after resize</small></span>
                  <ImageField value={image} onChange={(v) => { setImage(v); touch("image"); }} tint={previewTint} onPreviewLoad={onPreviewImg} />
                  {err("image")}
                </div>
                {isRoot && <AgentSetup model={model} onModel={setModel} locked={locked} />}
              </section>
            </>}

            {/* Step 3: what it costs, what will happen, and the one button. */}
            {!result && (
              <section id="launch-go" ref={launchCard} className={`card raised step-card launch-card ${step3 ? "done" : ""}`}>
                <div className="step-head"><StepN n="03" done={step3} /><h2>Launch</h2><span className="step-status"><span className="label">one signature</span></span></div>
                <div className="buy-grid">
                  <div className={`field buy-field ${invalid("firstBuy")}`} data-field="firstBuy">
                    <label htmlFor="first-buy">First buy <small className="muted">optional</small></label>
                    <div className="amount"><input id="first-buy" className="input mono" inputMode="decimal" value={firstBuy} disabled={!canBuy || busy} onChange={(ev) => setFirstBuy(ev.target.value.replace(/[^\d.,]/g, ""))} onBlur={() => touch("firstBuy")} placeholder="0.5" aria-describedby="first-buy-est" /><em>SOL</em></div>
                    <div className="buy-chips" role="group" aria-label="Quick first-buy amounts">
                      {QUICK_BUYS.map((v) => <button key={v} type="button" aria-pressed={firstBuy === v} disabled={!canBuy || busy} onClick={() => { setFirstBuy(firstBuy === v ? "" : v); touch("firstBuy"); }}>{v} SOL</button>)}
                    </div>
                    <span id="first-buy-est" className="buy-inline mono" aria-live="off">{buyLamports > 0n && canBuy ? <>{buyUsd !== null && <>≈ {roundUsd(buyUsd)} · </>}{buyEstimate?.tokens != null && !buyEstimate.loading ? <>≈ {compact(Number(buyEstimate.tokens) / 1e6)} {tag}</> : buyEstimate?.error ? "quote not ready yet" : "quoting…"}</> : null}</span>
                    {err("firstBuy")}
                  </div>
                  <div className="hint buy-hint">
                    {buyLamports > 0n && canBuy
                      ? <>Right after the launch lands, a second signature buys {isRoot ? `${tag} from its fresh` : `${sym(p)} → ${tag} through the tree, from your coin's fresh`} <Term k="curve">curve</Term>. <span className="slip"><Term k="slippage">Slippage</Term> <span className="seg inline">{SLIPPAGES.map((s) => <button key={s} type="button" aria-pressed={slippage === s} onClick={() => setSlippage(s)}>{s / 100}%</button>)}</span></span></>
                      : isRoot ? <>Buy the first tokens of your coin with SOL right after the launch. Being first on your own <Term k="curve">curve</Term> is the cheapest entry there will ever be.</>
                      : <>Buy the first tokens of your coin through the whole tree (SOL → parent → your coin), right after the launch, from its fresh <Term k="curve">curve</Term>.</>}
                  </div>
                </div>
                {!isRoot && <>
                  <button type="button" className="linkish advanced-toggle" aria-expanded={advanced} onClick={() => setAdvanced((a) => !a)}>{advanced ? "▾" : "▸"} Advanced{feeValue !== undefined && !errors.feeBps ? <span className="muted"> · creator fee {feeValue} bps</span> : ""}</button>
                  {advanced && (
                    <div className="grid-2 advanced">
                      <label className={`field ${invalid("feeBps")}`} data-field="feeBps"><span>Creator fee · bps · optional</span><div className="amount"><input className="input mono" inputMode="numeric" value={feeBps} onChange={(ev) => setFeeBps(ev.target.value.replace(/\D/g, "").slice(0, 3))} onBlur={() => touch("feeBps")} placeholder="pump schedule" /><em>{feeValue !== undefined && !errors.feeBps ? `${(feeValue / 100).toFixed(2)}%` : "bps"}</em></div>{err("feeBps")}</label>
                      <div className="hint">The creator fee is the slice of every trade that goes to the <Term k="creatorFee">fee split</Term> ({CHILD_SPLIT_YOU}). Leave it empty for pump.fun's default schedule, which steps down as market cap grows. A custom rate (0–300 bps = 0–3%) is fixed for the coin's life and only honoured on quote-control chains.</div>
                    </div>
                  )}
                </>}

                <div className="launch-summary" aria-label="Summary">
                  <div className="sum-row"><span>Tree</span><b>{isRoot ? <>New tree · priced in SOL <DepthBadge depth={0} /></> : p ? <>Under {sym(p)} <DepthBadge depth={newDepth} /></> : "Pick a parent in step 1"}</b></div>
                  <div className="sum-split"><span><Term k="creatorFee">Fee split</Term></span>{splitBar}<small>{isRoot ? ROOT_SPLIT_YOU : CHILD_SPLIT_YOU}</small></div>
                  {isRoot && <div className="sum-row"><span>Agent</span><b className="sum-agent">{modelLabel}</b></div>}
                </div>

                {policyProblem && <p className="error" role="alert">{policyProblem}</p>}
                {poolReady && <CostBox feeLamports={feeLamports} buyLamports={buyCost} seedLamports={seedLamports} simulatedRentLamports={simRent} connected={connected} balance={balance.lamports} balanceError={balance.error} solUsd={stats?.solUsd ?? null} estimate={buyEstimate} />}
                {tried && problems.length > 0 && <ul className="problems" role="alert">{problems.map((f) => <li key={f}>{errors[f]}</li>)}</ul>}

                {error && <div className="notice bad launch-error" role="alert"><span><b>The launch stopped.</b> {error.text}{error.beforeSigning ? " Nothing was signed or sent. Your form is kept." : /nothing was (sent|charged)/i.test(error.text) ? "" : " If a transaction was sent, it is linked in the step list."}</span>{!busy && <button type="button" className="btn sm" onClick={go}>Try again</button>}</div>}
                {steps.length > 0 && <Steps steps={steps} title={busy ? "Launching" : error ? "Stopped" : "Done"} />}

                {!error && (!connected ? <div className="connect-row"><WalletMultiButton>Connect wallet to launch</WalletMultiButton><span className="hint">Phantom, Solflare or any wallet-standard wallet. The transaction is built here and signed there; Spore never holds a key.</span></div>
                  : <div className="launch-row">
                      <button type="button" className={`btn lg accent launch-btn ${busy ? "is-launching" : launchDisabled ? "" : "is-ready"}`} disabled={launchDisabled} onClick={go}>{busy ? <ProgressArc done={stepsDone} total={steps.length} /> : <svg className="launch-ico" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M8 14V7.5M8 7.5C8 4.8 6 3 3 3c0 2.8 2 4.5 5 4.5Zm0 0c0-2.7 2-4.5 5-4.5 0 2.8-2 4.5-5 4.5Z" /></svg>}<span>{launchLabel}</span>{busy && steps.length > 0 && <span className="launch-count mono">{stepsDone}/{steps.length}</span>}</button>
                      {dry && <span className="hint">Dry run as <span className="mono">{creator?.slice(0, 6)}…</span>: simulated on mainnet state, nothing sent.</span>}
                      {!busy && !dry && agentPaused && <span className="hint">Pick a parent in step 1, or try again in a moment.</span>}
                      {!busy && !dry && !agentPaused && eligibleNow && !insufficient && <span className="hint">{problems.length && tried ? `${problems.length} thing${problems.length === 1 ? "" : "s"} to fix above` : "Simulated before you sign; your wallet shows the exact cost."}</span>}
                    </div>)}
                {connected && poolReady && e && e.ok && !creator && <div className="hint">Waiting for the wallet address…</div>}

                {!busy && steps.length === 0 && (
                  <details className="plan-details">
                    <summary>What happens when you press launch</summary>
                    <Steps steps={planSteps} plan />
                  </details>
                )}
                <details className="fine-print">
                  <summary>Rules &amp; limits</summary>
                  <ul>
                    <li>A new tree's first coin sits at depth 0; coins grow under it one level at a time, up to pump.fun's depth limit{maxDepth != null ? ` (${maxDepth} levels under a root today)` : ""}.</li>
                    <li>Mayhem-mode coins cannot be parents.</li>
                    <li>A tree with a coin that graduated but has not migrated yet waits for the migration.</li>
                    <li>The fee split is written at creation and can never be changed.</li>
                    <li>{NON_CUSTODIAL}</li>
                  </ul>
                  <Link to="/fees">Fees &amp; rules →</Link>
                </details>
              </section>
            )}
          </div>

          <aside className="spawn-side">
            {/* Live preview: the card this coin will get, updating as the form is typed. After the launch the
                issued certificate in the success card replaces it. */}
            {!result && <section className="card preview cert-card" style={{ "--tint": previewTint } as CSSProperties} aria-label="Preview of your coin's card">
              <Certificate state="preview" image={image?.dataUrl ?? null} onImg={onPreviewImg} name={name} symbol={symbol}
                parent={isRoot ? null : p ? { symbol: p.symbol, mint: p.mint, image: p.image } : null} pending={!isRoot && !p}
                depth={newDepth} segments={segments} splitLine={isRoot ? ROOT_SPLIT_YOU : CHILD_SPLIT_YOU} model={isRoot ? modelLabel : null} source={e ? "from Spore" : "policy"}>
                {description.trim() ? <p className="preview-desc">{description.trim()}</p>
                  : isRoot ? <p className="hint cert-hint">Priced in SOL: the first coin of a new tree. Every coin launched under it buys {symbol ? `$${symbol}` : "it"} on every trade and keeps it locked in its own curve.</p>
                  : <p className="hint cert-hint">Priced in {parentTag}: every buy routes SOL → {route.length ? `${route.join(" → ")} → ` : "parent → "}{symbol ? `$${symbol}` : "your coin"}.</p>}
                {(twitter || telegram || website) && <div className="preview-links">{twitter && <span>X {normaliseSocial("twitter", twitter).replace(/^https?:\/\/(www\.)?/, "")}</span>}{telegram && <span>TG {normaliseSocial("telegram", telegram).replace(/^https?:\/\/(www\.)?/, "")}</span>}{website && <span>{normaliseSocial("website", website).replace(/^https?:\/\/(www\.)?/, "")}</span>}</div>}
              </Certificate>
            </section>}
            <section className="card pad side-split">
              {elig.loading && !e ? <Skeleton h={140} r={10} />
                : e ? <SplitPreview unit={isRoot ? "trade" : "fee"} shares={e.shares} agent={isRoot ? (e.agent ?? { bps: ROOT_SPLIT.agent, address: null }) : null} you={creator} parentCreator={e.parentCreator} grandparentCreator={e.grandparentCreator} platform={e.platform} parentSymbol={p?.symbol} grandparentSymbol={p?.parent?.symbol} quoteSymbol={isRoot ? "SOL" : p ? sym(p) : null} />
                : <><span className="eyebrow">Creator fee split</span><p className="muted">{isRoot ? `A new tree: ${ROOT_SPLIT_YOU}.` : `${CHILD_SPLIT_YOU}.`} Set once at creation; the admin is revoked, so it can never change. {SPORE_BUYBACK}</p></>}
              <Link to="/fees" className="side-link">Fees &amp; rules →</Link>
            </section>
          </aside>
        </div>
      </div>
      {!result && <LaunchBar target={launchCard} image={image?.dataUrl ?? null} symbol={symbol} total={total} label={connected ? launchLabel : "Connect wallet"} disabled={connected ? launchDisabled : false} hidden={busy || !!result || !!error}
        onPress={() => { if (connected) void go(); else scrollTo(launchCard.current); }} />}
    </>
  );
}
