// What an agent coin says about itself (lib/agents/purpose.mjs): purpose line, hype line, site link.
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentSiteUrl, purposeLine, purposeDescription } from "../lib/agents/purpose.mjs";

test("purpose: the site link is the root agent's page and the purpose names the root", () => {
  assert.equal(agentSiteUrl("FTcrJuck7yqAgQQzv9uud7MH2Av8S3mP9iveiXsutNeX"), "https://sporepad.com/agents/FTcrJuck7yqAgQQzv9uud7MH2Av8S3mP9iveiXsutNeX");
  assert.equal(agentSiteUrl("x", "https://example.test/"), "https://example.test/agents/x");
  assert.equal(purposeLine("SPREAD"), "By the $SPREAD agent, built to pump $SPREAD: every trade of this coin buys $SPREAD.");
  assert.equal(purposeLine("$SPREAD"), purposeLine("SPREAD"));
});

test("purpose: the description keeps the idea, the why line and the purpose within 400 characters", () => {
  const d = purposeDescription({ description: "Rumours travel.", why: "Agents move faster than facts." }, "SPREAD");
  assert.equal(d, "Rumours travel. — Why now: Agents move faster than facts. · By the $SPREAD agent, built to pump $SPREAD: every trade of this coin buys $SPREAD.");
  const long = purposeDescription({ description: "x".repeat(500), why: "w".repeat(140) }, "SPREAD");
  assert.ok(long.length <= 400, `length ${long.length}`);
  assert.ok(long.endsWith("buys $SPREAD."), "the purpose is never dropped");
  assert.ok(long.includes("Why now: " + "w".repeat(140)), "the why line survives; the description is clipped");
  assert.equal(purposeDescription({ description: "d" }, null), "d · By the its root agent, built to pump its root: every trade of this coin buys its root.");
});
