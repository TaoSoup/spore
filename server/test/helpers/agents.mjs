// Shared fixtures for the root-agent tests: the small tree of helpers/tree.mjs (optionally on a
// sqlite file, for the CLI), recent trades on its root so it has momentum, and a fake language model.
import { Db } from "../../lib/db.mjs";
import { Model } from "../../lib/model.mjs";
import { K, PLATFORM, T22, base, quiet } from "./tree.mjs";

export { K, PLATFORM, quiet };

/** The tree (ROOT → A → G, ROOT → B) with metadata, on `file` (":memory:" by default). */
export function agentTree(file = ":memory:", { trades = 30 } = {}) {
  const db = new Db(file);
  const model = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], log: quiet });
  model.load();
  model.setGlobal({ maxCurveDepth: 2, initialRealTokenReserves: "793100000000000", createV2Enabled: true, whitelistedQuoteMints: [] });
  model.setSolUsd(100);
  model.upsertCoin({ mint: K.ROOT, curve: "C_ROOT", depth: 0, quoteMint: null, ...base, creator: K.U, virtualQuoteReserves: "100000000000", createdAt: 1000 });
  model.upsertCoin({ mint: K.A, curve: "C_A", depth: 1, quoteMint: K.ROOT, ...base, virtualQuoteReserves: "2000000000000000", realQuoteReserves: "50000000000000", createdAt: 2000 });
  model.upsertCoin({ mint: K.B, curve: "C_B", depth: 1, quoteMint: K.ROOT, ...base, virtualQuoteReserves: "1000000000000000", realQuoteReserves: "10000000000000", createdAt: 3000 });
  model.upsertCoin({ mint: K.G, curve: "C_G", depth: 2, quoteMint: K.A, ...base, virtualQuoteReserves: "500000000000000", realQuoteReserves: "7000000000000", createdAt: 4000 });
  const names = [[K.ROOT, "Mushroom Grove", "GROVE"], [K.A, "Spore Cat", "SCAT"], [K.B, "Glow Cat", "GLOWCAT"], [K.G, "Tiny Cap", "TCAP"]];
  for (const [mint, name, symbol] of names) model.setMint({ mint, decimals: 6, tokenProgram: T22, name, symbol, uri: `https://ipfs.io/ipfs/${symbol}`, onchainAt: 1 });
  model.setMeta("https://ipfs.io/ipfs/GROVE", { image: "https://ipfs.io/ipfs/imgGrove", description: "A glowing mushroom grove where spores drift between trees. Fungi, moss and forest memes.", twitter: "https://x.com/grove", telegram: null, website: null, fetchedAt: 1, ok: true });
  const t = Math.floor(Date.now() / 1000);
  for (let i = 0; i < trades; i++) model.recordTrade({ sig: `T${i}`, mint: K.ROOT, idx: 0, slot: 100 + i, time: t - i * 60, isBuy: i % 3 !== 0, user: "U", baseAmount: "1000", quoteAmount: "1000", priceQuote: 1e-7, priceUsd: 1e-5, valueUsd: 250 });
  return { db, model };
}

/** A language model double: `answers` are returned (or thrown when an Error) in order, every call recorded. */
export function fakeLlm(answers = []) {
  const calls = [];
  return {
    available: true, model: "test-model", calls,
    async chatJson(messages, opts) { calls.push({ messages, opts }); const a = answers.length > 1 ? answers.shift() : answers[0]; if (a instanceof Error) throw a; return structuredClone(a); },
    snapshot: () => ({ available: true, calls: calls.length }),
  };
}
