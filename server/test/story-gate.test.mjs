// The story gate (lib/story-gate.mjs) and same-word bursts (lib/word-bursts.mjs): counted buyers across a story's coins,
// capped inflow, breadth by coins or by same-word launches, lift against the floor or a normal, and what fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { storyGateGen, drainGate } from "../lib/story-gate.mjs";
import { WordBursts, launchWords } from "../lib/word-bursts.mjs";

const NOW = 1_795_000_000, SOL = 100;
const buy = (m, u, usd, t = NOW - 600) => ({ m, t, b: true, u, v: usd });
const sell = (m, u, usd, t = NOW - 500) => ({ m, t, b: false, u, v: usd });
const card = (key, mints) => ({ key, coins: mints.map((mint) => ({ mint, name: mint, symbol: mint })) });
const run = (cards, trades, o = {}) => drainGate(storyGateGen({ cards, trades, nowS: NOW, solUsd: SOL, ...o, cfg: { minBuyers: 4, minInflowSol: 0.5, breadthBuyers: 2, ...o.cfg } }));

test("story gate: distinct counted buyers across coins; creators, sellers-out, dust buys and spray wallets left out; capped inflow; breadth by coins", () => {
  const trades = [
    buy("A", "w1", 50), buy("B", "w1", 50),               // one wallet in two coins: one buyer
    buy("A", "w2", 500), buy("A", "w3", 30), buy("B", "w4", 40), buy("B", "w5", 40),
    buy("A", "CREATOR", 900),                            // the coin's creator
    buy("A", "w6", 40), sell("A", "w6", 60),             // sold more than it bought
    buy("B", "w7", 0.5),                                 // under $1
  ];
  for (let i = 0; i < 25; i++) trades.push(buy(`X${i}`, "spray", 5)); // 25 coins: a spray wallet
  trades.push(buy("A", "spray", 100));
  const v = run([card("n:1", ["A", "B"])], trades, { creatorOf: (m) => (m === "A" ? "CREATOR" : null) }).get("n:1");
  assert.equal(v.buyers, 5, "w1..w5");
  assert.equal(v.inflowSol, 5.1, "w1 1 SOL, w2 capped at 3, w3 .3, w4 .4, w5 .4");
  assert.equal(v.coins5, 2, "A: w1 w2 w3; B: w1 w4 w5");
  assert.equal(v.lift, null, "no series state: the lift is unknown");
  assert.deepEqual(v.fails, ["lift"]);
  const young = run([card("n:1", ["A", "B"])], trades, { liftOf: () => ({ last30: 30, base30: null, old: false }) }).get("n:1");
  assert.equal(young.lift, 10, "under 6 h old with no normal: against the floor of 3");
  const unknown = run([card("n:1", ["A", "B"])], trades, { liftOf: () => ({ last30: 30, base30: null, old: true }) }).get("n:1");
  assert.deepEqual([unknown.lift, unknown.fails.includes("lift"), unknown.score], [null, true, 0], "an older story whose normal is not known does not pass");
});

test("story gate: lift from the series against its normal; breadth by same-word launches; outside the window ignored; score", () => {
  const trades = [buy("A", "a", 20), buy("A", "b", 20), buy("A", "c", 20), buy("A", "d", 20), buy("A", "old", 20, NOW - 2000)];
  const liftOf = (k) => (k === "n:1" ? { last30: 40, base30: 5, old: true } : null);
  const v1 = run([card("n:1", ["A"])], trades, { liftOf }).get("n:1");
  assert.deepEqual([v1.buyers, v1.lift, v1.coins5], [4, 8, 1]);
  assert.deepEqual(v1.fails, ["breadth"]);
  const v2 = run([card("n:1", ["A"])], trades, { liftOf, wordsOf: () => ["jensen", "spy"], creatorsOf: (w) => (w === "jensen" ? 6 : 2) }).get("n:1");
  assert.equal(v2.pass, true);
  assert.deepEqual(v2.word, { word: "jensen", creators: 6 });
  assert.equal(v2.score, Math.round(8 * Math.log(5) * 100) / 100);
  const low = run([card("n:1", ["A"])], trades, { liftOf: () => ({ last30: 40, base30: 1, old: true }) }).get("n:1");
  assert.equal(low.lift, Math.round((40 / 3) * 10) / 10, "a normal under the floor counts as the floor");
});

test("word bursts: distinct creators per distinctive word in the hour; standing and generic words ignored; sweep", () => {
  assert.deepEqual(launchWords("Jensen Spy Coin", "JSPY"), ["jensen", "spy", "jspy"]);
  assert.deepEqual(launchWords("Trump Pepe", "MEME"), [], "standing and generic words");
  let t = NOW;
  const wb = new WordBursts({ now: () => t * 1000 });
  for (let i = 0; i < 5; i++) wb.add({ name: "Jensen Affair", symbol: "JA", creator: `c${i}`, timestamp: NOW - 100 });
  wb.add({ name: "Jensen", symbol: "J", creator: "c0", timestamp: NOW + 10 }); // the same creator again, later
  assert.equal(wb.creators("jensen"), 5);
  assert.deepEqual(wb.bursts().map((b) => b.word), ["affair", "jensen"]);
  t = NOW + 3600;
  wb.sweep();
  assert.equal(wb.creators("jensen", t), 1, "only c0's later launch is inside the hour");
  assert.equal(wb.byWord.has("affair"), false);
});
