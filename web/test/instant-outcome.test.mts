// What a page does with an instant trade's answer (lib/instant-outcome.ts, carried out by components/useInstantTrade.ts
// on the Portfolio page, the map's side panel and the coin page): the toast and the step after it, for each kind of
// answer; the presets as buttons and the press guard of the coin page's always-visible row. Then the
// two small rules the map's preset popover rests on: a popover holds the page's keys while it is open (lib/dialog.ts),
// and it closes once its button scrolled out of the panel that clips it (lib/clip.ts). Nothing here reads the chain.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Coin } from "../src/lib/api.ts";
import type { InstantResult } from "../src/lib/instant-trade.ts";
import type { TradeBlock } from "../src/lib/trade-route.ts";
const { instantStep, instantProgress } = await import("../src/lib/instant-outcome.ts");
const F = await import("../src/lib/format.ts");
const { holdPageKeys, isDialogOpen } = await import("../src/lib/dialog.ts");
const { clippedOut } = await import("../src/lib/clip.ts");

const coin = { mint: "Mint111111111111111111111111111111111111111", symbol: "ABC", decimals: 6 } as Coin;
const nameless = { mint: "Zzzz1111111111111111111111111111111111111pump", symbol: null, decimals: 6 } as Coin;

test("progress: what the toast says while the trade runs", () => {
  assert.equal(instantProgress({ side: "buy", sol: 0.1 }, "$ABC"), "Buying $ABC with 0.1 SOL…");
  assert.equal(instantProgress({ side: "sell", pct: 50 }, "$ABC"), "Selling 50% of $ABC…");
});

test("done: a success toast with the transaction's link, and the page refreshes", () => {
  const buy: InstantResult = { kind: "done", coin, side: "buy", sig: "SIG1", amountIn: 100_000_000n, amountOut: 1_234_567_890n };
  const s = instantStep(buy, true);
  assert.equal(s.kind, "done");
  if (s.kind !== "done") return;
  assert.deepEqual(s.link, { href: "https://solscan.io/tx/SIG1", label: "view transaction" });
  assert.equal(s.text, `Bought ≈ ${F.amount(F.tokens(1_234_567_890n, 6))} $ABC for ${F.sol(F.lamportsToSol(100_000_000n))}`);
  const sell = instantStep({ kind: "done", coin: nameless, side: "sell", sig: "SIG2", amountIn: 500_000_000n, amountOut: 12_345_678n }, false);
  assert.equal(sell.kind, "done");
  if (sell.kind !== "done") return;
  // a coin without a symbol is named by its short mint, as everywhere else
  assert.equal(sell.text, `Sold ${F.amount(F.tokens(500_000_000n, 6))} ${F.short(nameless.mint)} for ≈ ${F.sol(F.lamportsToSol(12_345_678n))}`);
});

test("ticket: the reason, the amount for the ticket's field, and the deposit way only for the trading wallet", () => {
  const r: InstantResult = { kind: "ticket", coin, side: "buy", amount: "0.5", reason: "sol", text: "Not enough SOL.", deposit: true };
  assert.deepEqual(instantStep(r, true), { kind: "ticket", text: "Not enough SOL.", deposit: true, coin, side: "buy", amount: "0.5" });
  // a connected wallet has no deposit view: the toast carries no action
  assert.equal((instantStep(r, false) as { deposit: boolean }).deposit, false);
  const cap: InstantResult = { kind: "ticket", coin, side: "sell", amount: "12.5", reason: "cap", text: "Over the limit." };
  assert.deepEqual(instantStep(cap, true), { kind: "ticket", text: "Over the limit.", deposit: false, coin, side: "sell", amount: "12.5" });
});

test("blocked: handed to the page with the block (no toast of its own); failed: the error and a link when a transaction went out", () => {
  const block = { kind: "mayhem", coin } as unknown as TradeBlock;
  assert.deepEqual(instantStep({ kind: "blocked", coin, side: "buy", block }, true), { kind: "blocked", coin, block });
  // nothing to sell is a plain error, the map's Sell included (it has no position check of its own)
  assert.deepEqual(instantStep({ kind: "failed", coin, side: "sell", text: "This wallet holds no $ABC to sell." }, true), { kind: "failed", text: "This wallet holds no $ABC to sell." });
  const link = { href: "https://solscan.io/tx/X", label: "check it" };
  assert.deepEqual(instantStep({ kind: "failed", coin, side: "buy", text: "Expired.", link }, true), { kind: "failed", text: "Expired.", link });
});

test("a popover holds the page's keys while it is open; releasing twice is harmless", () => {
  assert.equal(isDialogOpen(), false);
  const a = holdPageKeys(), b = holdPageKeys();
  assert.equal(isDialogOpen(), true);
  a(); a();
  assert.equal(isDialogOpen(), true, "the second popover still holds them");
  b();
  assert.equal(isDialogOpen(), false);
});

test("a button scrolled out of the panel that clips it closes its popover; one partly in view keeps it", () => {
  const panel = { box: { left: 0, top: 100, right: 340, bottom: 600 }, x: true, y: true };
  const btn = (top: number) => ({ left: 20, top, right: 160, bottom: top + 34 });
  assert.equal(clippedOut(btn(300), [panel]), false);
  assert.equal(clippedOut(btn(80), [panel]), false, "partly under the top edge: still seen");
  assert.equal(clippedOut(btn(60), [panel]), true, "wholly above the panel's top");
  assert.equal(clippedOut(btn(600), [panel]), true, "wholly below its bottom");
  // an ancestor that clips only across does not close it for a vertical scroll
  assert.equal(clippedOut(btn(60), [{ ...panel, y: false }]), false);
  assert.equal(clippedOut({ left: 400, top: 300, right: 500, bottom: 334 }, [{ ...panel, y: false }]), true);
  assert.equal(clippedOut(btn(60), []), false);
});

test("signer: the map honours Trade-with and never changes it; the Portfolio page uses the trading wallet", async () => {
  const { instantSigner } = await import("../src/lib/instant-outcome.ts");
  const base = { trading: true, unlocked: true, walletConnected: true } as const;
  // map, extension chosen: the extension signs, even with the trading wallet unlocked or locked; nothing is flipped
  assert.deepEqual(instantSigner({ ...base, mode: "chosen", tradeWith: "wallet" }), { use: "wallet", setTrading: false });
  assert.deepEqual(instantSigner({ ...base, mode: "chosen", tradeWith: "wallet", unlocked: false }), { use: "wallet", setTrading: false });
  // map, trading wallet chosen: it signs, or is asked to unlock
  assert.deepEqual(instantSigner({ ...base, mode: "chosen", tradeWith: "trading" }), { use: "trading", setTrading: false });
  assert.deepEqual(instantSigner({ ...base, mode: "chosen", tradeWith: "trading", unlocked: false }), { use: "unlock", setTrading: false });
  // map, extension chosen but not connected: the trading wallet is the only signer (as useTrader)
  assert.deepEqual(instantSigner({ ...base, mode: "chosen", tradeWith: "wallet", walletConnected: false }), { use: "trading", setTrading: false });
  assert.deepEqual(instantSigner({ ...base, mode: "chosen", tradeWith: "wallet", walletConnected: false, unlocked: false }), { use: "unlock", setTrading: false });
  // no trading wallet: the connected one, or none
  assert.deepEqual(instantSigner({ mode: "chosen", trading: false, unlocked: false, tradeWith: "trading", walletConnected: true }), { use: "wallet", setTrading: false });
  assert.deepEqual(instantSigner({ mode: "chosen", trading: false, unlocked: false, tradeWith: "trading", walletConnected: false }), { use: "none", setTrading: false });
  // Portfolio (as before): the trading wallet trades whatever Trade-with says, and is made the choice once unlocked
  assert.deepEqual(instantSigner({ ...base, mode: "portfolio", tradeWith: "wallet" }), { use: "trading", setTrading: true });
  assert.deepEqual(instantSigner({ ...base, mode: "portfolio", tradeWith: "trading" }), { use: "trading", setTrading: false });
  assert.deepEqual(instantSigner({ ...base, mode: "portfolio", tradeWith: "wallet", unlocked: false }), { use: "unlock", setTrading: false });
  assert.deepEqual(instantSigner({ mode: "portfolio", trading: false, unlocked: false, tradeWith: "trading", walletConnected: true }), { use: "wallet", setTrading: false });
  assert.deepEqual(instantSigner({ mode: "portfolio", trading: false, unlocked: false, tradeWith: "trading", walletConnected: false }), { use: "none", setTrading: false });
});

test("preset choices: the popover's texts, the coin page row's short texts, and the trade each one is", async () => {
  const { presetChoices } = await import("../src/lib/instant-outcome.ts");
  assert.deepEqual(presetChoices("buy", [0.1, 0.5, 1]), [
    { text: "0.1 SOL", short: "0.1", spec: { side: "buy", sol: 0.1 } },
    { text: "0.5 SOL", short: "0.5", spec: { side: "buy", sol: 0.5 } },
    { text: "1 SOL", short: "1", spec: { side: "buy", sol: 1 } },
  ]);
  assert.deepEqual(presetChoices("sell", [25, 50, 100]), [
    { text: "25%", short: "25%", spec: { side: "sell", pct: 25 } },
    { text: "50%", short: "50%", spec: { side: "sell", pct: 50 } },
    { text: "100%", short: "100%", spec: { side: "sell", pct: 100 } },
  ]);
  // the index a press picks is the preset at that index, so a pick past the end trades nothing
  assert.equal(presetChoices("buy", [0.25])[3], undefined);
  assert.deepEqual(presetChoices("sell", []), []);
});

test("an always-visible preset counts only once armed for the guard, and never from a held key", async () => {
  const { pressCounts } = await import("../src/lib/instant-outcome.ts");
  const guardMs = 300;
  // off (a trade runs, or the row is not pressable): nothing counts
  assert.equal(pressCounts({ armedAt: null, now: 10_000, guardMs }), false);
  // inside the guard after the buttons appeared or came back on: ignored; at and after it: counts
  assert.equal(pressCounts({ armedAt: 1_000, now: 1_000, guardMs }), false);
  assert.equal(pressCounts({ armedAt: 1_000, now: 1_299, guardMs }), false);
  assert.equal(pressCounts({ armedAt: 1_000, now: 1_300, guardMs }), true);
  assert.equal(pressCounts({ armedAt: 1_000, now: 60_000, guardMs }), true);
  // a repeating key never counts, armed or not
  assert.equal(pressCounts({ armedAt: 1_000, now: 60_000, guardMs, repeat: true }), false);
  assert.equal(pressCounts({ armedAt: 1_000, now: 60_000, guardMs, repeat: false }), true);
});
