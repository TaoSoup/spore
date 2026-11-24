// scripts/story-groups.mjs: stories found from attention (shared distinctive word + shared buyers), replayed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { autoGroup, medianOverlap, anchorOk, scoreLabels, parseArgs, STOP } from "../scripts/story-groups.mjs";

const n = (id, title, ws) => ({ id, title, buyers: ws.length, wallets: new Set(ws) });
const range = (p, a, b) => Array.from({ length: b - a }, (_, i) => `${p}${a + i}`);

test("anchorOk: never-words, everyday words and bare numbers are not anchors", () => {
  assert.deepEqual(["jensen", "trump", "movie", "128", "gta6", "fees", "helius"].map(anchorOk), [true, false, false, false, true, false, true]);
  assert.ok(STOP.includes("movie") && STOP.includes("support"));
});

test("medianOverlap: the median share of each narrative's wallets also bought by the others; bots left out", () => {
  const a = n(1, "a", ["w1", "w2", "w3", "w4"]), b = n(2, "b", ["w1", "w2", "x1", "x2"]), c = n(3, "c", ["y1", "y2"]);
  assert.equal(medianOverlap([a, b, c]), 0.5, "a 50%, b 50%, c 0%: the median is 50%");
  assert.equal(medianOverlap([a, b], new Set(["w1", "w2"])), 0, "the shared wallets are bots: nothing shared");
});

test("autoGroup: a word joins narratives only when they share buyers; launches alone never do; one group per narrative", () => {
  const story = range("s", 0, 60);
  const ns = [
    n(1, "jensen the white leather jacket", [...story.slice(0, 40), ...range("a", 0, 40)]),
    n(2, "nvidia reinstates jensen huang ceo", [...story.slice(20, 60), ...range("b", 0, 30)]),
    n(3, "stand with jensen huang", [...story.slice(10, 30), ...range("c", 0, 10)]),
    n(4, "2006 nvidia frog mascot", range("d", 0, 50)),
    n(5, "ninja nvidia office dog", range("e", 0, 40)),
    n(6, "post quantum crypto narrative", range("f", 0, 60)),
    n(7, "post quantum wallets", range("g", 0, 30)),
    n(8, "upside down cat", range("h", 0, 30)), n(9, "elon chips down", range("h", 0, 30)), // shared buyers, but "down" is an everyday word
  ];
  const launches = new Map([["jensen", { now: 300, base: 10 }], ["quantum", { now: 15, base: 1 }], ["nvidia", { now: 60, base: 6 }]]);
  const g = autoGroup(ns, launches, { yieldWords: new Set(["nvidia"]) });
  assert.deepEqual(g.map((x) => [x.key, x.members.map((m) => m.id).sort()]), [["t:huang-jensen", [1, 2, 3]]],
    "Jensen joins (shared buyers); nvidia qualifies only through Jensen's titles, then shares nothing and is dropped; quantum bursts in launches but shares no buyers; 'down' is never an anchor");
  assert.match(g[0].why, /launches \+ shared buyers/);
  assert.equal(g[0].buyers, new Set(ns.slice(0, 3).flatMap((m) => [...m.wallets])).size);
});

test("autoGroup: two tiny narratives that overlap by chance do not make a story", () => {
  const ns = [n(1, "kabosumama cate", ["a", "b", "c"]), n(2, "kabosumama peanut", ["a", "b"])];
  assert.deepEqual(autoGroup(ns, new Map(), {}), [], "the second one has under 20 buyers");
  assert.equal(autoGroup(ns, new Map(), { minSecond: 2 }).length, 1);
});

test("scoreLabels: the group holding most active 'in' ids, and the 'out' ids it wrongly holds", () => {
  const groups = [{ key: "t:jensen", members: [{ id: 1 }, { id: 2 }, { id: 9 }] }, { key: "t:x", members: [{ id: 3 }] }];
  assert.deepEqual(scoreLabels(groups, { subjects: { "t:huang-jensen": { in: [1, 2, 3, 4], out: [9] } } }, new Set([1, 2, 3])),
    [{ key: "t:huang-jensen", activeIn: 3, group: "t:jensen", found: 2, wrong: [9] }]);
});

test("parseArgs", () => {
  const o = parseArgs(["--db", "x", "--hours", "1", "--base-hours", "24", "--steady", "10"]);
  assert.deepEqual([o.hours, o.baseHours, o.steady, o.minLaunches, o.burst], [1, 24, 10, 5, 3]);
  assert.throws(() => parseArgs([]), /required/);
  assert.throws(() => parseArgs(["--db", "x", "--hours", "0"]), /above 0/);
});
