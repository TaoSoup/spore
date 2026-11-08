// Listed-asset families on the full map (DESIGN §11.5): the index keeps every coin quoted in an asset, the
// bubble counts them all, the map draws a capped slice (children-bearing and day-old coins, then the biggest).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Db } from "../lib/db.mjs";
import { Model } from "../lib/model.mjs";
import { PublicKey } from "../lib/sdk.mjs";
import { K, PLATFORM, quiet, base } from "./helpers/tree.mjs";

const key = (seed) => new PublicKey(createHash("sha256").update(`asset-family-${seed}`).digest()).toBase58();

test("the full map draws a capped slice of a listed asset's family while the family's bubble counts every coin", () => {
  const db = new Db(":memory:");
  const now = 1_800_000_000_000;
  const model = new Model(db, { platformWallet: PLATFORM, splitBps: [5000, 0, 0, 5000], mode: "all", now: () => now, log: quiet, assetFamilyDraw: 3 });
  model.load();
  const ASSET = K.S;
  model.setQuoteUsd(ASSET, 1);
  const coin = (i, extra = {}) => model.upsertCoin({ mint: key(`c${i}`), curve: key(`curve${i}`), depth: 0, quoteMint: ASSET, tracked: true, virtualQuoteReserves: "1000", realQuoteReserves: String(100 - i), createdAt: Math.floor(now / 1000) - 10 * 86_400, ...base, ...extra });
  for (let i = 0; i < 8; i++) coin(i); // eight old coins, locked 100 … 93
  const young = coin(20, { realQuoteReserves: "1", createdAt: Math.floor(now / 1000) - 3600 }); // created an hour ago: always drawn
  const parent = coin(21, { realQuoteReserves: "1" });                                           // has a child: always drawn
  model.upsertCoin({ mint: key("kid"), curve: key("kidcurve"), depth: 1, quoteMint: parent.mint, tracked: true, virtualQuoteReserves: "1", realQuoteReserves: "1", ...base });
  const map = model.mapAll({ all: true }).body;
  const top = map.roots.find((r) => r.coin.mint === ASSET);
  assert.ok(top && top.coin.asset, "the asset is a family top");
  assert.equal(top.coin.children, 10, "the bubble counts every coin quoted in the asset");
  const drawn = top.children.map((n) => n.coin.mint);
  assert.equal(drawn.length, 3, "the cap");
  assert.ok(drawn.includes(young.mint), "a day-old coin is always drawn");
  assert.ok(drawn.includes(parent.mint), "a coin with children is always drawn");
  assert.ok(drawn.includes(key("c0")), "then the biggest locked value");
  const delta = model.mapSince({ all: true, since: 0 }).body;
  const underAsset = delta.nodes.filter((n) => n.parentMint === ASSET).map((n) => n.mint);
  assert.deepEqual(underAsset.sort(), drawn.slice().sort(), "the delta carries the same slice");
  assert.equal(model.mapTotal(true), 1 + 3 + 1, "drawn nodes: the asset, its slice and the grandchild");
  db.close();
});
