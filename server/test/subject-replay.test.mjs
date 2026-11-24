// scripts/subject-replay.mjs: candidate subject words, the fold of narratives into subjects (one subject per narrative,
// distinct buyers counted once), and the label checks. Pure functions only; readNarratives is covered by a tiny database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { words, wordOk, candidates, readTable, fold, checkLabels, readNarratives, parseArgs, NEVER, QUIET_SHARE, newLoose } from "../scripts/subject-replay.mjs";

const n = (id, title, ws) => ({ id, title, buyers: ws.length, wallets: new Set(ws) });

test("words: whole words, lower case, once each; wordOk keeps 3+ characters with a letter", () => {
  assert.deepEqual(words("Jensen the White Leather-Jacket jensen"), ["jensen", "the", "white", "leather", "jacket"]);
  assert.deepEqual(words("kugen and xiaohuang friendship").includes("huang"), false, "a surname inside a longer word is not the word");
  assert.deepEqual(["gta", "128", "6", "ai", "gta6"].map(wordOk), [true, false, false, false, true]);
});

test("candidates: words held by min+ narratives with buyers; never-words marked, not dropped; distinct union; co-words and variants", () => {
  const ns = [
    n(1, "jensen the white leather jacket", ["a", "b", "c"]),
    n(2, "nvidia reinstates jensen huang ceo", ["b", "d"]),
    n(3, "jensen white swan event", ["e"]),
    n(4, "stand with jensen huang", []), // no buyers: not counted
    n(5, "christmas cat", ["f"]), n(6, "christmas dog", ["g"]), n(7, "christmas inu", ["h"]),
    n(8, "gta6 leak", ["i"]),
  ];
  const c = candidates(ns, { min: 3 });
  const j = c.find((x) => x.word === "jensen");
  assert.equal(j.n, 3);
  assert.equal(j.buyers, 5, "a, b, c, d, e: b once");
  assert.equal(j.sumAngles, 6);
  assert.equal(j.never, null);
  assert.deepEqual(j.members.map((m) => m.id), [1, 2, 3]);
  assert.ok(j.coWords.includes("white"), "white is in 2 of 3");
  const x = c.find((y) => y.word === "christmas");
  assert.equal(x.never, "season");
  assert.equal(c.find((y) => y.word === "huang"), undefined, "huang: only 1 narrative with buyers");
  const g = candidates([n(1, "gta 6", ["a"]), n(2, "gta online", ["b"]), n(3, "leonida gta", ["c"]), n(4, "gta6 leak", ["d"])], { min: 3 }).find((y) => y.word === "gta");
  assert.deepEqual(g.variants, ["gta6"]);
  assert.ok(NEVER.standing.includes("trump") && NEVER.season.includes("christmas"));
});

test("readTable: a fixed key, else one from sorted anchors; quiet flag; no anchors, a bad or repeated key throws", () => {
  const [s, q] = readTable({ subjects: [{ title: "Jensen Huang", anchors: ["Huang", "jensen", "jensen"] }, { key: "t:nvidia", title: "Nvidia", anchors: ["nvidia", "geforce"], quiet: true }] });
  assert.equal(s.key, "t:huang-jensen");
  assert.equal(s.quiet, false);
  assert.equal(q.key, "t:nvidia", "a fixed key survives an added anchor");
  assert.equal(q.quiet, true);
  assert.throws(() => readTable({ subjects: [{ title: "x", anchors: [] }] }), /no anchors/);
  assert.throws(() => readTable({ subjects: [{ anchors: ["a", "b"] }, { anchors: ["b", "a"] }] }), /two subjects/);
  assert.throws(() => readTable({ subjects: [{ key: "t:a-b", anchors: ["x"] }, { anchors: ["b", "a"] }] }), /two subjects/, "a fixed key and a built key collide");
  assert.throws(() => readTable({ subjects: [{ key: "nvidia", anchors: ["nvidia"] }] }), /malformed key/);
  assert.throws(() => readTable({ subjects: [{ key: "t:Nvidia", anchors: ["nvidia"] }] }), /malformed key/);
  assert.throws(() => readTable({ quietShare: 1.5, subjects: [] }), /quietShare/);
  assert.throws(() => readTable({ quietShare: "0.03", subjects: [] }), /quietShare/);
  assert.throws(() => readTable({ subjects: [{ title: "Nvidia", anchors: ["nvidia"], quiet: "true" }] }), /quiet flag/, "a quiet written as text must not become a story row");
});

test("fold: whole-word anchors, one subject per narrative, excludes and includes, distinct buyers, shows and checks", () => {
  const ns = [
    n(1, "jensen the white leather jacket", ["a", "b", "c"]),
    n(2, "nvidia reinstates jensen huang ceo", ["b", "d"]),
    n(3, "2006 nvidia frog mascot", ["x"]),
    n(4, "kugen and xiaohuang friendship", ["y"]),
    n(5, "jensen huang shrimp party", []),
    n(6, "michael burry nvidia short", ["z", "a"]),
    n(7, "nvidia ceo gooner exposed", ["q"]),
  ];
  const table = { subjects: [{ title: "Jensen Huang", anchors: ["jensen", "huang"], include: [7] }, { title: "Nvidia", anchors: ["nvidia"], exclude: [2, 6] }] };
  const r = fold(ns, table, 100);
  const [jh, nv] = r.subjects;
  assert.deepEqual(jh.members.map((m) => m.id), [1, 2, 7, 5], "xiaohuang is not huang; 7 is included without the words; a narrative with no buyers is a member, not an angle");
  assert.equal(jh.angles, 3);
  assert.equal(jh.buyers, 5, "a b c d q, b once");
  assert.equal(jh.sumAngles, 6);
  assert.equal(jh.largest, 3);
  assert.equal(jh.share, 0.05);
  assert.equal(jh.shows, true);
  assert.equal(jh.ok, true);
  assert.deepEqual(nv.members.map((m) => m.id), [3], "2 and 6 are excluded; 7 is included elsewhere");
  assert.equal(nv.shows, false, "one angle: stays as a card");
  assert.deepEqual(r.conflicts, [], "2 holds both words but Nvidia excludes it");
  assert.equal(fold(ns, table, 4).subjects[0].ok, false, "a subject over the site's buyers fails the check");
});

test("fold, tie rule: a title with anchors of two subjects goes to a story row before a quiet row, then the longer anchor, then table order", () => {
  const ns = [
    n(1, "anthropic solves riemann hypothesis", ["a"]),
    n(2, "anthropic ipo", ["b"]), n(3, "claude code", ["c"]), n(4, "riemann proof lean4", ["d"]),
    n(5, "tesla optimus robot", ["e"]), n(6, "tesla roadster", ["f"]), n(7, "optimus", ["g"]),
    n(8, "grok plays gta", ["h"]), n(9, "gta 6", ["i"]), n(10, "grok 5", ["j"]),
    n(11, "nvidia reinstates jensen huang ceo", ["k"]), n(12, "nvidia frog", ["l"]), n(13, "huang nvidia", ["m"]),
  ];
  const r = fold(ns, { subjects: [
    { title: "Nvidia", anchors: ["nvidia"], quiet: true }, { title: "Jensen Huang", anchors: ["jensen", "huang"] },
    { title: "Anthropic", anchors: ["anthropic", "claude"], quiet: true }, { title: "Riemann", anchors: ["riemann"] },
    { title: "Tesla", anchors: ["tesla"], quiet: true }, { title: "Optimus", anchors: ["optimus"], quiet: true },
    { title: "GTA", anchors: ["gta"] }, { title: "Grok", anchors: ["grok"], quiet: true },
  ] }, 100);
  const of = (id) => r.subjects.find((s) => s.members.some((m) => m.id === id)).key;
  assert.equal(of(11), "t:huang-jensen", "a story row beats a quiet row listed above it, with no exclude");
  assert.equal(of(13), "t:huang-jensen", "a story row beats a longer anchor of a quiet row (huang 5 < nvidia 6)");
  assert.equal(of(1), "t:riemann", "Riemann (story) against Anthropic (quiet)");
  assert.equal(of(5), "t:optimus", "Optimus against Tesla, both quiet: the longer anchor");
  assert.equal(of(8), "t:gta", "GTA (story) against Grok (quiet), although grok is the longer anchor");
  const r2 = fold([n(1, "nba gta crossover", ["a"]), n(2, "nba finals", ["b"]), n(3, "gta 6", ["c"]), n(4, "grok gta", ["d"])], { subjects: [{ title: "GTA", anchors: ["gta"] }, { title: "NBA", anchors: ["nba"] }, { title: "Grok", anchors: ["grok"] }] }, 10);
  assert.deepEqual(r2.subjects[0].members.map((m) => m.id), [1, 3], "both story rows, same anchor length: table order");
  assert.deepEqual(r2.subjects[2].members.map((m) => m.id), [4], "both story rows: the longer anchor (grok over gta)");
  assert.equal(r.conflicts.length, 5);
});

test("fold, quiet rows: show as a block only at quietShare of site buyers; the option beats the table, which beats the default", () => {
  const ns = [n(1, "nvidia frog", ["a", "b"]), n(2, "nvidia office dog", ["c"]), n(3, "gta 6", ["d"]), n(4, "gta online", ["e"])];
  const table = { subjects: [{ title: "Nvidia", anchors: ["nvidia"], quiet: true }, { title: "GTA", anchors: ["gta"] }] };
  const at = (site, opts, t = table) => fold(ns, t, site, opts).subjects.map((s) => s.shows);
  assert.deepEqual(at(100), [true, true], "3 of 100 buyers is 3%: the default level");
  assert.deepEqual(at(101), [false, true], "just under 3%: the quiet row stays as cards; a story row does not care");
  assert.deepEqual(at(101, { quietShare: 0.02 }), [true, true]);
  assert.deepEqual(at(101, undefined, { ...table, quietShare: 0.02 }), [true, true], "the table's own level");
  assert.deepEqual(at(101, { quietShare: 0.02 }, { ...table, quietShare: 0.5 }), [true, true], "the option beats the table (lower)");
  assert.deepEqual(at(100, { quietShare: 0.5 }, { ...table, quietShare: 0.02 }), [false, true], "the option beats the table (higher)");
  assert.throws(() => fold(ns, { ...table, quietShare: "0.5" }, 100), /fraction/, "a string is not a level");
  assert.deepEqual(at(null), [false, true], "no site count: a quiet row cannot show");
  assert.equal(fold(ns, table, 100).quietShare, QUIET_SHARE);
  assert.throws(() => fold(ns, table, 100, { quietShare: 3 }), /fraction/);
  assert.throws(() => fold(ns, { ...table, quietShare: 0 }, 100), /fraction/);
  const one = fold([n(1, "nvidia frog", ["a", "b", "c", "d"])], table, 10).subjects[0];
  assert.equal(one.shows, false, "40% but one angle: still a card");
});

test("checkLabels: in, out, neverAnchors, oneSubjectFor", () => {
  const ns = [n(1, "jensen jacket", ["a"]), n(2, "huang ceo", ["b"]), n(3, "nvidia frog", ["c"]), n(4, "christmas cat", ["d"])];
  const r = fold(ns, { subjects: [{ title: "Jensen Huang", anchors: ["jensen", "huang"] }, { title: "Christmas", anchors: ["christmas"] }] }, 10);
  assert.deepEqual(checkLabels(r, { subjects: { "t:huang-jensen": { in: [1, 2], out: [3] } }, oneSubjectFor: [[1, 2]] }), { pass: true, failures: [] });
  const bad = checkLabels(r, { subjects: { "t:huang-jensen": { in: [3], out: [1] }, "t:nope": {} }, neverAnchors: ["Christmas"], oneSubjectFor: [[1, 3]] });
  assert.equal(bad.pass, false);
  assert.equal(bad.failures.length, 5, bad.failures.join("\n"));
  const rq = fold(ns, { subjects: [{ title: "Jensen Huang", anchors: ["jensen", "huang"] }, { title: "Nvidia", anchors: ["nvidia"], quiet: true }] }, 10);
  assert.deepEqual(checkLabels(rq, { none: [4], quiet: ["t:nvidia"], story: ["t:huang-jensen"], absent: ["t:toly"] }), { pass: true, failures: [] });
  const bq = checkLabels(rq, { none: [3], quiet: ["t:huang-jensen", "t:gone"], story: ["t:nvidia"], absent: ["t:nvidia"] });
  assert.equal(bq.failures.length, 5, bq.failures.join("\n"));
  assert.deepEqual(checkLabels(rq, { story: ["t:huang-jensen"] }).failures, ["t:nvidia: not labelled quiet or story"], "every row needs a kind once kinds are labelled");
  const back = fold(ns, { subjects: [{ title: "Jensen Huang", anchors: ["jensen", "huang"] }, { key: "t:toly-yakovenko", title: "Toly", anchors: ["toly", "jacket"] }] }, 10);
  assert.equal(checkLabels(back, { absent: ["t:toly"], neverAnchors: ["toly"] }).failures.length, 1, "a deleted row back under another key: absent misses it, neverAnchors does not");
});

test("newLoose: new narratives with buyers that joined no subject, most buyers first", () => {
  const ns = [n(1, "jensen jacket", ["a"]), n(5, "jensen white", ["b"]), n(6, "nvidia ceo gooner exposed", ["c", "d"]), n(7, "frog", ["e"]), n(8, "quiet nothing", []), n(3, "old loose", ["f"])];
  const r = fold(ns, { subjects: [{ title: "Jensen Huang", anchors: ["jensen", "huang"] }] }, 10);
  assert.deepEqual(newLoose(ns, r, 4).map((m) => m.id), [6, 7], "5 joined Jensen; 8 has no buyers; 3 is older");
});

test("readNarratives: per-narrative distinct $1+ buyers in the window, read-only; parseArgs", () => {
  const dir = mkdtempSync(join(tmpdir(), "spore-subj-"));
  const file = join(dir, "s.sqlite");
  try {
    const w = new DatabaseSync(file);
    w.exec(`CREATE TABLE narratives (id INTEGER PRIMARY KEY, title TEXT, theme TEXT);
      CREATE TABLE coin_tags (mint TEXT PRIMARY KEY, narrative_id INTEGER);
      CREATE TABLE trades (mint TEXT, time INTEGER, is_buy INTEGER, user TEXT, value_usd REAL);
      INSERT INTO narratives VALUES (1, 'jensen jacket', 'tech'), (2, 'gta 6', 'games');
      INSERT INTO coin_tags VALUES ('m1', 1), ('m2', 1), ('m3', 2);
      INSERT INTO trades VALUES ('m1', 1000, 1, 'a', 5), ('m2', 1001, 1, 'a', 5), ('m2', 1002, 1, 'b', 0.5), ('m2', 1003, 0, 'c', 9), ('m3', 10, 1, 'd', 9), ('m9', 1000, 1, 'e', 3);`);
    w.close();
    const r = readNarratives(file, { untilT: 3600 + 500, hours: 1 });
    assert.deepEqual(r.narrs.map((x) => [x.id, x.coins, x.buyers]), [[1, 2, 1], [2, 1, 0]], "a once; b under $1; c sold; d before the window");
    assert.equal(r.siteBuyers, 2, "a and e");
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  assert.deepEqual(parseArgs(["--db", "x", "--hours", "6", "--anchors", "t.json", "--expect", "l.json", "--json"]).hours, 6);
  assert.throws(() => parseArgs(["--db", "x", "--expect", "l.json"]), /needs --anchors/);
  const q = parseArgs(["--db", "x", "--anchors", "t.json", "--quiet-share", "0.02", "--new-after", "1000"]);
  assert.deepEqual([q.quietShare, q.newAfter], [0.02, 1000]);
  assert.throws(() => parseArgs(["--db", "x", "--anchors", "t.json", "--quiet-share", "3"]), /fraction/);
  assert.throws(() => parseArgs(["--db", "x", "--quiet-share", "0.02"]), /--quiet-share needs --anchors/);
  assert.throws(() => parseArgs(["--db", "x", "--new-after", "10"]), /--new-after needs --anchors/);
  assert.throws(() => parseArgs([]), /required/);
});
