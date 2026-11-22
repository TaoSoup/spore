// The coin page's one trade card and "Launch a child" card: the one-shot continuation after an unlock
// (lib/pending-intent.ts: every drop condition, fired once, never without a click), the launch's in-flight lock, the
// presets the card shows from the stored settings (three or four), and the shared launch form rules
// (lib/launch-form.ts). Pure: no React, no wallet, no chain, nothing signs.
import { test } from "node:test";
import assert from "node:assert/strict";
const P = await import("../src/lib/pending-intent.ts");
const S = await import("../src/lib/trade-settings.ts");
const { presetChoices } = await import("../src/lib/instant-outcome.ts");
const L = await import("../src/lib/launch-form.ts");

const T0 = 1_000_000;
const base = { kind: "trade" as const, mint: "MINT", page: "/c/MINT", key: "buy|p1=0.25|500|1", wallet: "WALLET1", at: T0, payload: { spec: { side: "buy", sol: 0.25 } } };
const now = (over: Partial<{ kind: "trade" | "launch"; mint: string; page: string; key: string; wallet: string | null; now: number; unlocked: boolean }> = {}) =>
  ({ kind: "trade" as const, mint: "MINT", page: "/c/MINT", key: base.key, wallet: "WALLET1" as string | null, now: T0 + 5_000, unlocked: true, ...over });

test("intentDecision: fires only unlocked, unchanged and within 60 s; waits while locked", () => {
  assert.equal(P.intentDecision(base, now()), "fire");
  assert.equal(P.intentDecision(base, now({ unlocked: false })), "wait");
  assert.equal(P.intentDecision(base, now({ now: T0 + P.INTENT_TTL_MS })), "fire", "exactly 60 s");
  assert.equal(P.intentDecision(null, now()), "none", "no click remembered: nothing fires, unlocked or not");
  assert.equal(P.intentDecision(null, now({ unlocked: false })), "none");
});

test("intentDecision: every drop condition", () => {
  const drops: [string, ReturnType<typeof now>][] = [
    ["older than 60 s", now({ now: T0 + P.INTENT_TTL_MS + 1 })],
    ["older than 60 s, still locked", now({ now: T0 + P.INTENT_TTL_MS + 1, unlocked: false })],
    ["the clock went back", now({ now: T0 - 1 })],
    ["another coin", now({ mint: "OTHER" })],
    ["another page", now({ page: "/portfolio" })],
    ["another kind", now({ kind: "launch" })],
    ["the key changed (side, amount, quote terms)", now({ key: "sell|p1=50|500|1" })],
    ["changed while locked", now({ key: "x", unlocked: false })],
    ["another trading wallet unlocked (forgot the password, then an import or a new one)", now({ wallet: "WALLET2" })],
    ["the trading wallet was removed", now({ wallet: null })],
    ["another trading wallet, still locked", now({ wallet: "WALLET2", unlocked: false })],
  ];
  for (const [why, n] of drops) assert.equal(P.intentDecision(base, n), "drop", why);
  assert.equal(P.intentDecision({ ...base, at: NaN }, now()), "drop", "a broken time");
  assert.equal(P.intentDecision({ ...base, wallet: "" }, now({ wallet: "" })), "drop", "no wallet known at the click");
});

test("tradeIntentKey: the side, the clicked preset's value or the custom text, the slippage and the cap all count", () => {
  const k = (o: Partial<Parameters<typeof P.tradeIntentKey>[0]> = {}) => P.tradeIntentKey({ side: "buy", source: { kind: "preset", index: 1 }, presets: [0.1, 0.25, 0.5, 1], custom: "", slippageBps: 500, capSol: 1, ...o });
  const at = k();
  assert.equal(k(), at, "the same state, the same key");
  assert.equal(k({ custom: "2" }), at, "the custom text does not matter to a preset click");
  for (const other of [k({ side: "sell" }), k({ source: { kind: "preset", index: 2 } }), k({ presets: [0.1, 0.3, 0.5, 1] }), k({ slippageBps: 300 }), k({ capSol: 2 })]) assert.notEqual(other, at);
  const c = (custom: string) => P.tradeIntentKey({ side: "buy", source: { kind: "custom" }, presets: [0.1], custom, slippageBps: 500, capSol: 1 });
  assert.equal(c("0.3"), c(" 0.3 "));
  assert.notEqual(c("0.3"), c("0.4"), "the custom amount changed");
  assert.equal(P.tradeIntentKey({ side: "buy", source: { kind: "preset", index: 5 }, presets: [0.1], custom: "", slippageBps: 1, capSol: 1 }).includes("p5=?"), true, "a preset that is gone");
});

test("launchIntentKey: any field changed drops the launch", () => {
  const f = { name: "Cat", symbol: "CAT", image: "data:image/png;base64," + "A".repeat(200), devBuy: "0.1", description: "", website: "", twitter: "", telegram: "" };
  const at = P.launchIntentKey(f);
  assert.equal(P.launchIntentKey({ ...f, name: " Cat " }), at, "surrounding spaces are not a change");
  for (const k of ["name", "symbol", "devBuy", "description", "website", "twitter", "telegram"] as const) assert.notEqual(P.launchIntentKey({ ...f, [k]: f[k] + "x" }), at, k);
  assert.notEqual(P.launchIntentKey({ ...f, image: f.image.slice(0, -1) + "B" }), at, "another image");
  assert.notEqual(P.launchIntentKey({ ...f, image: null }), at, "no image");
});

test("OneShot: a remembered click fires at most once; drop and changes forget it; nothing fires that was not clicked", () => {
  const shot = new P.OneShot<{ n: number }>();
  assert.equal(shot.take(now()), null, "nothing remembered: an unlock alone never trades");
  shot.remember({ ...base, payload: { n: 1 } });
  assert.equal(shot.take(now({ unlocked: false })), null, "still locked: kept");
  assert.ok(shot.pending);
  assert.deepEqual(shot.take(now()), { payload: { n: 1 } }, "unlocked: fires");
  assert.equal(shot.take(now()), null, "once only");
  assert.equal(shot.pending, null);
  shot.remember({ ...base, payload: { n: 2 } });
  assert.equal(shot.take(now({ key: "changed" })), null, "changed: dropped");
  assert.equal(shot.take(now()), null, "and gone, even if the state comes back");
  shot.remember({ ...base, payload: { n: 3 } });
  shot.drop();
  assert.equal(shot.take(now()), null, "the panel closed without an unlock, the tab was hidden");
  shot.remember({ ...base, payload: { n: 4 } });
  shot.remember({ ...base, at: T0 + 1_000, payload: { n: 5 } });
  assert.deepEqual(shot.take(now()), { payload: { n: 5 } }, "a second click replaces the first: one trade, not two");
  assert.equal(shot.take(now()), null);
  shot.remember({ ...base, payload: { n: 6 } });
  assert.equal(shot.take(now({ wallet: "WALLET2" })), null, "another wallet unlocked: dropped");
  assert.equal(shot.take(now()), null, "and gone, even if the first wallet comes back");
});

test("OneShot: a null or undefined payload (the launch's) still fires once", () => {
  const shot = new P.OneShot<null>();
  shot.remember({ ...base, kind: "launch", payload: null });
  assert.equal(shot.take(now({ kind: "launch", unlocked: false })), null, "still locked: nothing yet");
  assert.deepEqual(shot.take(now({ kind: "launch" })), { payload: null }, "unlocked: fires, payload null");
  assert.equal(shot.take(now({ kind: "launch" })), null, "once only");
  const u = new P.OneShot<undefined>();
  u.remember({ ...base, payload: undefined });
  assert.deepEqual(u.take(now()), { payload: undefined });
});

test("InFlightLock: one launch at a time, also across the continuation; released afterwards", () => {
  const lock = new P.InFlightLock();
  assert.equal(lock.take(), true);
  assert.equal(lock.held, true);
  assert.equal(lock.take(), false, "a double click in the same render");
  assert.equal(lock.take(), false, "the continuation after an unlock beside a click");
  lock.release();
  assert.equal(lock.take(), true, "free again once the flow ended");
});

test("presets on the card: four by default, three when three are stored, the user's own values kept", () => {
  const four = S.parseTradeSettings({});
  assert.deepEqual(presetChoices("buy", four.buyPresets).map((c) => c.short), ["0.1", "0.25", "0.5", "1"]);
  assert.deepEqual(presetChoices("sell", four.sellPresets).map((c) => c.short), ["25%", "50%", "75%", "100%"]);
  const three = S.parseTradeSettings({ buy: "0.2,1,3", sell: "10,50,100" });
  assert.deepEqual(presetChoices("buy", three.buyPresets).map((c) => c.spec), [{ side: "buy", sol: 0.2 }, { side: "buy", sol: 1 }, { side: "buy", sol: 3 }]);
  assert.deepEqual(presetChoices("sell", three.sellPresets).map((c) => c.short), ["10%", "50%", "100%"]);
  const own4 = S.parseTradeSettings({ buy: "0.05,0.2,2,5", sell: "5,10,20,100" });
  assert.deepEqual([own4.buyPresets, own4.sellPresets], [[0.05, 0.2, 2, 5], [5, 10, 20, 100]]);
});

test("launch form rules (shared by the Launch page and the coin page's card)", () => {
  const ok = { name: "Little Cat", symbol: "LCAT", hasImage: true, description: "", twitter: "", telegram: "", website: "" };
  assert.deepEqual(L.launchErrors(ok), {});
  assert.ok(L.launchErrors({ ...ok, name: " " }).name);
  assert.ok(L.launchErrors({ ...ok, name: "x".repeat(33) }).name);
  assert.ok(L.launchErrors({ ...ok, symbol: "" }).symbol);
  assert.ok(L.launchErrors({ ...ok, symbol: "ab" }).symbol, "lower case is not a ticker");
  assert.ok(L.launchErrors({ ...ok, hasImage: false }).image);
  assert.ok(L.launchErrors({ ...ok, description: "x".repeat(401) }).description);
  assert.ok(L.launchErrors({ ...ok, website: "not a url" }).website);
  assert.deepEqual(L.launchErrors({ ...ok, twitter: "@spore", telegram: "t.me/spore", website: "https://example.com" }), {});
  assert.ok(L.launchErrors({ ...ok, firstBuy: "abc", buyLamports: 0n }).firstBuy);
  assert.ok(L.launchErrors({ ...ok, feeValue: 301 }).feeBps);
  assert.equal(L.sanitizeTicker("li'l pepe!42xxxxxxxxxxx"), "LILPEPE42XXXX");
  assert.equal(L.childCanBuy({ depth: 0, quoteMint: null }), true);
  assert.equal(L.childCanBuy({ depth: 0, quoteMint: "USDC" }), false, "a root priced in a listed asset: no SOL route for a dev buy");
  assert.equal(L.childCanBuy({ depth: 2, quoteMint: "X" }), true);
});
