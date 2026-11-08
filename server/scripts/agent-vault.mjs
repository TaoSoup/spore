#!/usr/bin/env node
// Agent wallet vault (DESIGN §13.1). Prints public addresses only; never a key.
//
//   AGENT_VAULT_KEY_FILE=~/.config/spore/agent-vault.key DATA_DIR=./data node scripts/agent-vault.mjs <cmd>
//     init                 make the vault key file (mode 600). Back it up away from DATA_DIR.
//     new <rootMint>       create the agent's wallet for a root (refuses when one exists)
//     address <rootMint>   print the agent's public address
//     list                 all agent wallets (root, address, created)
//     budget <rootMint>    SOL + USDC balance and whether the agent may start (needs RPC_URL; never printed)
import { join } from "node:path";
import { AgentVault, initVaultKey, readVaultKey } from "../lib/agents-live/vault.mjs";
import { readBudget, canStart } from "../lib/agents-live/budget.mjs";

const [cmd, root] = process.argv.slice(2);
const keyFile = process.env.AGENT_VAULT_KEY_FILE;
const dataDir = process.env.DATA_DIR || "./data";
const need = (v, what) => { if (!v) { console.error(`missing ${what}`); process.exit(2); } return v; };

try {
  if (cmd === "init") { console.log(`vault key written: ${initVaultKey(need(keyFile, "AGENT_VAULT_KEY_FILE"))}`); process.exit(0); }
  const vault = new AgentVault({ dir: join(dataDir, "agents", "wallets"), vaultKey: readVaultKey(need(keyFile, "AGENT_VAULT_KEY_FILE")) });
  if (cmd === "new") { const w = vault.create(need(root, "rootMint")); console.log(`${w.root} → ${w.address}`); }
  else if (cmd === "address") console.log(vault.address(need(root, "rootMint")));
  else if (cmd === "list") for (const w of vault.list()) console.log(`${w.root} → ${w.address}  ${new Date(w.createdAt * 1000).toISOString()}`);
  else if (cmd === "budget") {
    const { Rpc } = await import("../lib/rpc.mjs");
    const rpc = new Rpc({ url: need(process.env.RPC_URL, "RPC_URL"), log: { info() {}, warn() {}, error() {} } });
    const address = vault.address(need(root, "rootMint"));
    let solUsd = null;
    try { const r = await fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot", { signal: AbortSignal.timeout(8000) }); solUsd = Number((await r.json())?.data?.amount) || null; } catch { /* unknown price */ }
    const b = await readBudget(rpc, address, { solUsd });
    console.log(JSON.stringify({ root, address, sol: b.sol, usdc: b.usdc, solUsd, usd: b.usd, start: canStart(b) }, null, 2));
    rpc.close?.();
  } else if (cmd === "withdraw") {
    // Moves an agent wallet's SOL (minus the fee) and USDC to `to`. Dry by default: prints what would
    // move. `--send` signs with the vault key and sends — run by the owner, never by the service.
    //   withdraw <rootMint> <toAddress> [--send] [--sol-only|--usdc-only]
    const to = process.argv[4], send = process.argv.includes("--send"), solOnly = process.argv.includes("--sol-only"), usdcOnly = process.argv.includes("--usdc-only");
    const { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } = await import("@solana/web3.js");
    const { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } = await import("@solana/spl-token");
    const { Rpc } = await import("../lib/rpc.mjs");
    const { USDC_MINT } = await import("../lib/agents-live/budget.mjs");
    const { recentBlockhash, simulate, sendAndConfirm } = await import("../lib/agents-live/tx.mjs");
    let toKey; try { toKey = new PublicKey(need(to, "toAddress")); } catch { console.error("toAddress is not a Solana address"); process.exit(2); }
    const rpc = new Rpc({ url: need(process.env.RPC_URL, "RPC_URL"), log: { info() {}, warn() {}, error() {} } });
    const signer = vault.signer(need(root, "rootMint"));
    const b = await readBudget(rpc, signer.address);
    const FEE = 10_000, RENT = 890_880; // fee headroom; rent-exempt floor of a system account stays unless everything goes
    const usdc = new PublicKey(USDC_MINT), fromAta = getAssociatedTokenAddressSync(usdc, signer.publicKey), toAta = getAssociatedTokenAddressSync(usdc, toKey, true);
    const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 80_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 })];
    let solOut = 0, usdcOut = 0;
    if (!solOnly && b.usdcMicros > 0) { ixs.push(createAssociatedTokenAccountIdempotentInstruction(signer.publicKey, toAta, toKey, usdc), createTransferCheckedInstruction(fromAta, usdc, toAta, signer.publicKey, BigInt(b.usdcMicros), 6)); usdcOut = b.usdcMicros; }
    if (!usdcOnly) { const ataRent = usdcOut && !(await rpc.call("getAccountInfo", [toAta.toBase58(), { encoding: "base64" }]))?.value ? 2_039_280 : 0; solOut = Math.max(0, b.lamports - FEE - 60_000 - ataRent); if (solOut > 0) ixs.push(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: toKey, lamports: solOut })); }
    console.log(JSON.stringify({ from: signer.address, to: toKey.toBase58(), sol: solOut / 1e9, usdc: usdcOut / 1e6, mode: send ? "SEND" : "dry run (add --send)" }, null, 2));
    if (!solOut && !usdcOut) { console.log("nothing to move"); process.exit(0); }
    const bh = await recentBlockhash(rpc);
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: bh.blockhash, instructions: ixs }).compileToV0Message());
    const sim = await simulate(rpc, tx);
    if (!sim || sim.err != null) { console.error("simulation failed:", JSON.stringify(sim?.err ?? "no result").slice(0, 200), (sim?.logs || []).slice(-2).join(" | ")); process.exit(1); }
    console.log("simulation ok,", sim.unitsConsumed, "CU");
    if (!send) { console.log("dry run: nothing sent"); process.exit(0); }
    signer.signTransaction(tx);
    const r = await sendAndConfirm(rpc, tx, { lastValidBlockHeight: bh.lastValidBlockHeight });
    console.log("sent:", r.signature, "slot", r.slot);
    process.exit(0);
  } else { console.error("usage: agent-vault.mjs init | new <root> | address <root> | list | budget <root> | withdraw <root> <to> [--send]"); process.exit(2); }
} catch (e) { console.error(`agent-vault: ${e.message}`); process.exit(1); }
