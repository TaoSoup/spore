// The Discover page's coin rows, live numbers, family card and controls (web/src/lib/discover.ts): the price
// sparkline, the change and txns words, the safety chips and their amber rule, the foot line with dust, the post as a
// block with its time against the jump, the live merge of an SSE trade, the held Trending order, and the stored
// timeframe / tab / buy slot. No DOM, no network (a fake fetch for the two reads).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoinRow, TrendRow, WakeFamily, WakePost } from "../src/lib/api.ts";
const D = await import("../src/lib/discover.ts");
const { api } = await import("../src/lib/api.ts");

const NOW = 1_763_500_000;
const spark = (p: (number | null)[], from = NOW - 3600): CoinRow["spark"] => ({ from, step: 120, p });
const row = (mint: string, o: Partial<CoinRow> = {}): CoinRow => ({
  mint, name: "Fiona", symbol: "FIONA", image: null, createdAt: NOW - 86400, existing: true, mcapUsd: 100_000, priceUsd: 0.0001, sinceStart: null, buyers5m: 12,
  tf: { p0: 0.00008, chg: 25, volUsd: 5_000, buys: 40, sells: 10, buyers: 30 }, liqUsd: 20_000,
  spark: spark([...new Array(29).fill(0.00009), 0.0001]), safety: { devPct: 4, top10Pct: 31.2, sniperPct: 2.5, state: "ok" }, ...o,
});
const post = (o: Partial<WakePost> = {}): WakePost => ({ id: "1990000000000000001", url: "https://evil.example/x", at: NOW - 30 * 60, handle: "fiona", text: "First line\n\n\n\nSecond   \nthird", state: "ok", coins: 4, lead: 6 * 60, ...o });

test("1. the price sparkline: nulls skipped, scaled low to high, green when the last close is at or above the first", () => {
  const up = D.coinSparkPath([null, null, 1, 2, null, 3], 80, 24);
  assert.equal(up.tone, "up");
  assert.deepEqual([up.first, up.last], [1, 3]);
  // 3 points (the nulls are skipped, so the line joins over the gap); the first sits at the 27th of 30 slots
  assert.equal(up.d.split(/[ML]/).filter(Boolean).length, 3);
  assert.match(up.d, /^M/);
  const [x0, y0] = up.d.slice(1).split("L")[0].split(",").map(Number);
  assert.equal(x0, Math.round((1.5 + (26 * 77) / 29) * 10) / 10);
  assert.equal(y0, 22.5, "the lowest point at the bottom of the box");
  assert.equal(D.coinSparkPath([3, 2, 1], 80, 24).tone, "down");
  assert.equal(D.coinSparkPath([2, 2], 80, 24).tone, "up", "level reads green (last >= first)");
  assert.equal(D.coinSparkPath([2, 2], 80, 24).d, "M70.1,12L72.7,12".replace("70.1", String(Math.round((1.5 + 28 * 77 / 29) * 10) / 10)).replace("72.7", "78.5"));
  const one = D.coinSparkPath([null, 5], 80, 24);
  assert.match(one.d, /^M[\d.]+,12L78\.5,12$/, "a single trade is a short level stroke");
  for (const empty of [[], [null, null], undefined, "x", [0, -1, NaN]]) assert.deepEqual(D.coinSparkPath(empty, 80, 24), { d: "", tone: "flat", first: null, last: null });
  // more than 30 points: the newest 30
  assert.equal(D.coinSparkPath([100, ...new Array(30).fill(1)], 80, 24).first, 1);
  assert.equal(D.coinSparkLabel(up), "Price over the last hour: +200% from the first trade shown to the last");
  assert.equal(D.coinSparkLabel({ first: null, last: null }), "Price over the last hour: no trades");
});

test("2. change and txns words", () => {
  assert.deepEqual([25, 4.04, 0.04, -0.04, -12.34, 1150.2, 99.96, null, NaN].map((n) => D.chgText(n as number).text), ["+25%", "+4%", "0%", "0%", "−12.3%", "+1,150%", "+100%", "—", "—"]);
  assert.deepEqual([25, -3, 0, null].map((n) => D.chgText(n).tone), ["up", "down", "flat", "flat"]);
  assert.deepEqual(D.txns({ p0: 1, chg: 0, volUsd: 0, buys: 1200, sells: 34, buyers: 9 }), { total: "1,234", buys: "1.2K", sells: "34" });
  // buys and sells are compact, so each fits its own short line in a ~58 px phone cell ("2,345 / 1,567" ran over)
  assert.deepEqual(D.txns({ p0: 1, chg: 0, volUsd: 0, buys: 2345, sells: 1567, buyers: 9 }), { total: "3,912", buys: "2.35K", sells: "1.57K" });
  assert.deepEqual(D.txns({ p0: 1, chg: 0, volUsd: 0, buys: 456, sells: 0, buyers: 9 }), { total: "456", buys: "456", sells: "0" });
  assert.deepEqual(D.txns(undefined), { total: "—", buys: "—", sells: "—" });
  assert.deepEqual([4, 0.44, 12.5, 0, 0.05, 100, null, -1].map(D.pctText), ["4%", "0.4%", "13%", "0%", "<0.1%", "100%", "—", "—"]);
  assert.equal(D.buyLabel(0.5), "Buy 0.5 SOL");
  assert.equal(D.buyLabel(0.12345), "Buy 0.1235 SOL");
  assert.equal(D.buyLabel(1), "Buy 1 SOL");
});

test("3. safety chips: measured numbers, amber at or above the stated threshold, … while the chain read is pending, unknown figures hidden", () => {
  const ok = D.safetyChips({ devPct: 4, top10Pct: 31.2, sniperPct: 2.5, state: "ok" });
  assert.deepEqual(ok.map((c) => c.text), ["Dev 4%", "Top 10 31%", "Snipers 2.5%"]);
  assert.deepEqual(ok.map((c) => c.amber), [false, false, false]);
  const edge = D.safetyChips({ devPct: 10, top10Pct: 50, sniperPct: 20, state: "ok" });
  assert.deepEqual(edge.map((c) => c.amber), [true, true, true], "the thresholds are inclusive");
  const under = D.safetyChips({ devPct: 9.9, top10Pct: 49.4, sniperPct: 19.4, state: "ok" });
  assert.deepEqual(under.map((c) => [c.text, c.amber]), [["Dev 9.9%", false], ["Top 10 49%", false], ["Snipers 19%", false]]);
  // amber follows the number shown: 49.6 reads "50%", so it is amber, as its title says ("Amber at 50% or more")
  const shown = D.safetyChips({ devPct: 9.96, top10Pct: 49.6, sniperPct: 19.5, state: "ok" });
  assert.deepEqual(shown.map((c) => [c.text, c.amber]), [["Dev 10%", true], ["Top 10 50%", true], ["Snipers 20%", true]]);
  for (const v of [0.04, 0.44, 4.94, 4.96, 9.94, 9.95, 19.49, 19.5, 49.49, 49.5, 99.5]) {
    for (const c of D.safetyChips({ devPct: v, top10Pct: v, sniperPct: v, state: "ok" })) {
      const n = Number(c.text.split(" ").pop()!.replace(/%$/, ""));
      assert.equal(c.amber, !c.text.includes("<") && n >= D.SAFETY_AMBER[c.key], `${c.text}: the colour agrees with the number shown`);
    }
  }
  for (const c of edge) assert.match(c.title, /Amber at \d+% or more\.$/, "the threshold is in the title");
  assert.match(edge[0].title, /^The creator's wallet holds 10% of the supply now/);
  assert.match(edge[2].title, /launch block or the first 3 seconds/);
  const pend = D.safetyChips({ devPct: null, top10Pct: null, sniperPct: 22, state: "pending" });
  assert.deepEqual(pend.map((c) => [c.text, c.pending, c.amber]), [["Dev …", true, false], ["Top 10 …", true, false], ["Snipers 22%", false, true]]);
  assert.deepEqual(D.safetyChips({ devPct: 3, top10Pct: null, sniperPct: null, state: "ok" }).map((c) => c.text), ["Dev 3%"], "a figure not known once read is left out");
  assert.deepEqual(D.safetyChips({ devPct: null, top10Pct: null, sniperPct: null, state: "pending" }).map((c) => c.text), ["Dev …", "Top 10 …"], "the sniper share is not a chain read: no … for it");
  assert.deepEqual(D.safetyChips({ devPct: null, top10Pct: null, sniperPct: 7, state: "unknown" }).map((c) => c.text), ["Snipers 7%"], "a failed chain read keeps the recorded sniper share");
  for (const s of [{ devPct: null, top10Pct: null, sniperPct: null, state: "unknown" as const }, null, undefined]) assert.deepEqual(D.safetyChips(s), []);
  assert.deepEqual(D.SAFETY_AMBER, { dev: 10, top10: 50, snipers: 20 });
});

test("4. the foot line: more, hidden, dust, each only when not 0; the two-argument form is unchanged", () => {
  assert.equal(D.footLine(8, 23, 4), "8 more trading · 23 hidden: creator sold out or repeat launch · 4 dust");
  assert.equal(D.footLine(0, 0, 4), "4 dust");
  assert.equal(D.footLine(8, 0, 0), "8 more trading");
  assert.equal(D.footLine(8, 23), "8 more trading · 23 hidden: creator sold out or repeat launch");
  assert.equal(D.footLine(0, 0, null), null);
  assert.deepEqual(D.footParts(1, 2, 3).map((p) => p.title), [undefined, D.HIDDEN_TITLE, D.DUST_TITLE]);
});

test("5. the post as a block: when against the jump, the text with its paragraphs, the link rebuilt from the id", () => {
  assert.equal(D.postLead(post(), NOW - 20 * 60, NOW), "Posted 6 min before buying jumped");
  assert.equal(D.postLead(post({ lead: -83 * 60 }), null, NOW), "Posted 1 h 23 min after buying jumped");
  assert.equal(D.postLead(post({ lead: 30 }), null, NOW), "Posted as buying jumped");
  assert.equal(D.postLead(post({ lead: -59 }), null, NOW), "Posted as buying jumped");
  assert.equal(D.postLead(post({ lead: null, at: NOW - 3 * 3600 }), NOW - 600, NOW), "Posted 3 h ago", "a null lead is never recomputed");
  assert.equal(D.postLead(post({ lead: undefined, at: NOW - 900 }), NOW - 600, NOW), "Posted 5 min before buying jumped", "an older server without lead");
  assert.equal(D.postLead(post({ lead: null, at: null }), NOW, NOW), "");
  assert.deepEqual([59, 60, 6 * 60, 59 * 60, 83 * 60, 3 * 3600 + 600, 47 * 3600, 49 * 3600].map(D.durText), ["1 min", "1 min", "6 min", "59 min", "1 h 23 min", "3 h", "47 h", "2 days"]);
  const b = D.postBlock(post(), NOW - 20 * 60, NOW);
  assert.deepEqual(b, { href: "https://x.com/i/status/1990000000000000001", handle: "@fiona", lead: "Posted 6 min before buying jumped", text: "First line\n\nSecond\nthird", linked: "Linked by 4 coins" });
  const wait = D.postBlock(post({ state: "wait", text: null, handle: null, id: "../evil" }), NOW, NOW);
  assert.deepEqual([wait.href, wait.handle, wait.text], [null, null, ""]);
  assert.equal(D.postBody({ state: "ok", text: "a\r\nb\r\n\r\n\r\nc" }), "a\nb\n\nc");
});

test("6. live merge: price, market cap, change, the sparkline's last close; an older trade or another coin changes nothing", () => {
  const r = row("M1");
  assert.equal(D.liveMerge(r, { mint: "M2", time: NOW, priceUsd: 1 }), r);
  assert.equal(D.liveMerge(r, { mint: "M1", time: NOW, priceUsd: null }), r);
  assert.equal(D.liveMerge(r, { mint: "M1", time: NOW, priceUsd: 0 }), r);
  const n = D.liveMerge(r, { mint: "M1", time: NOW - 30, priceUsd: 0.00012 });
  assert.equal(n.priceUsd, 0.00012);
  assert.equal(Math.round(n.mcapUsd as number), 120_000, "market cap x new / old price");
  assert.equal(n.tf?.chg, 50, "against the timeframe's start price, 1 dp");
  assert.equal(n.spark?.p[29], 0.00012);
  assert.equal(n.spark?.from, r.spark?.from);
  assert.deepEqual(n.flash, { dir: "up", n: 1 });
  assert.equal(n.liveAt, NOW - 30);
  const m = D.liveMerge(n, { mint: "M1", time: NOW - 20, priceUsd: 0.00011 });
  assert.deepEqual(m.flash, { dir: "down", n: 2 }, "each move restarts the flash");
  assert.equal(D.liveMerge(m, { mint: "M1", time: NOW - 40, priceUsd: 5 }), m, "a trade older than the last applied is late");
  // a trade two steps after the window: it slides by two, the passed step keeps the last close
  const slid = D.liveMerge(r, { mint: "M1", time: (r.spark!.from) + 31 * 120 + 5, priceUsd: 0.0002 });
  assert.equal(slid.spark?.from, r.spark!.from + 2 * 120);
  assert.equal(slid.spark?.p.length, 30);
  assert.deepEqual(slid.spark?.p.slice(-3), [0.0001, 0.0001, 0.0002]);
  // without a price before, the market cap and the flash wait for the next read
  const bare = D.liveMerge(row("M1", { priceUsd: null }), { mint: "M1", time: NOW, priceUsd: 2 });
  assert.equal(bare.mcapUsd, 100_000);
  assert.equal(bare.flash, undefined);
  // no p0: the change stays as read
  assert.equal(D.liveMerge(row("M1", { tf: { p0: null, chg: null, volUsd: 0, buys: 0, sells: 0, buyers: 0 } }), { mint: "M1", time: NOW, priceUsd: 2 }).tf?.chg, null);
  // an old trade before the window leaves the sparkline alone
  assert.deepEqual(D.liveMerge(r, { mint: "M1", time: r.spark!.from - 10, priceUsd: 9 }).spark, r.spark);
});

test("7. live batches: rows and family cards change only when a trade applies; a read keeps a newer live price", () => {
  const rows = [row("A"), row("B")];
  const by = D.tradesByMint([{ mint: "B", time: NOW - 5, priceUsd: 0.0003 }, { mint: "B", time: NOW - 10, priceUsd: 0.0002 }, { mint: "Z", time: NOW, priceUsd: 1 }]);
  assert.deepEqual(by.get("B")!.map((t) => t.time), [NOW - 10, NOW - 5], "oldest first");
  const out = D.liveRows(rows, by);
  assert.notEqual(out, rows);
  assert.equal(out[0], rows[0]);
  assert.equal(out[1].priceUsd, 0.0003);
  assert.equal(out[1].flash?.n, 2);
  assert.equal(D.liveRows(rows, D.tradesByMint([{ mint: "Z", time: NOW, priceUsd: 1 }])), rows, "nothing applied: the same array");
  const fams = [{ coins: [row("A")] }, { coins: [row("C")] }];
  const lf = D.liveFamilies(fams, by.size ? D.tradesByMint([{ mint: "C", time: NOW, priceUsd: 0.0002 }]) : by);
  assert.equal(lf[0], fams[0]);
  assert.equal(lf[1].coins[0].priceUsd, 0.0002);
  assert.equal(D.liveFamilies(fams, new Map()), fams);
  // a read that arrived soon after the live trade keeps the live price, without a new flash; the times compared are
  // both this browser's arrival times (ms), never the server's asOf against a trade's on-chain time
  const T = 1_763_500_000_000;
  const stamped = D.liveRows(rows, D.tradesByMint([{ mint: "B", time: NOW - 10, priceUsd: 0.0003, at: T }]));
  const live = stamped[1];
  assert.equal(live.liveRecvAt, T);
  const fresh = [row("A"), row("B")];
  const kept = D.carryLive(fresh, stamped, T + 3_000);
  assert.equal(kept[1].priceUsd, 0.0003);
  assert.equal(kept[1].liveRecvAt, T, "the carried row keeps when its trade arrived");
  assert.equal(kept[1].flash, live.flash, "the same flash: no restart");
  assert.equal(kept[0], fresh[0]);
  const later = D.carryLive(fresh, stamped, T + D.LIVE_CARRY_MS + 1);
  assert.equal(later[1].priceUsd, fresh[1].priceUsd, "a read that arrived well after the trade includes it: its price wins");
  assert.equal(later[1].liveAt, NOW - 10, "and the last applied trade's time stays as a floor");
  assert.equal(D.liveMerge(later[1], { mint: "B", time: NOW - 20, priceUsd: 0.00005, at: T + 9_000 }), later[1], "a late, older trade does not move the newer price back");
  assert.equal(D.carryLive(fresh, out, T)[1].priceUsd, fresh[1].priceUsd, "a live price without an arrival time is not carried");
  const cf = D.carryLiveFamilies([{ coins: [row("B")] }], [{ coins: [live] }], T + 3_000);
  assert.equal(cf[0].coins[0].priceUsd, 0.0003);
});

test("7b. the reviewed case: a trade at chain time 100 reaches the page after a snapshot the server built at 101", () => {
  // shown: the live price 2 (mcap 2000) of a trade whose chain time (100) is before the answer's asOf (101); the old
  // rule (liveAt > asOf) dropped it and the market cap jumped back to 1000 until the next trade
  const base = row("X", { priceUsd: 1, mcapUsd: 1000, tf: { p0: 1, chg: 0, volUsd: 0, buys: 0, sells: 0, buyers: 0 } });
  const T = 1_000_000;
  const shown = D.liveMerge(base, { mint: "X", time: 100, priceUsd: 2, at: T });
  assert.deepEqual([shown.priceUsd, shown.mcapUsd], [2, 2000]);
  const after = D.carryLive([base], [shown], T + 1_500);
  assert.deepEqual([after[0].priceUsd, after[0].mcapUsd, after[0].tf?.chg], [2, 2000, 100]);
  // settle() re-applying an older answer (read before the trade arrived) keeps the live price too
  assert.equal(D.carryLive([base], [shown], T - 4_000)[0].priceUsd, 2);
});

test("8. the mints followed: the rows on screen; a folded cooling card's coins are not on screen", () => {
  const fams = [{ parent: { mint: "P1" }, state: "live", coins: [{ mint: "A" }] }, { parent: { mint: "P2" }, state: "cooling", coins: [{ mint: "B" }] }];
  assert.deepEqual([...D.screenMints(fams, null)], ["A"]);
  assert.deepEqual([...D.screenMints(fams, null, new Set(["P2"]))], ["A", "B"]);
  assert.deepEqual([...D.screenMints(null, [{ mint: "T" }, { mint: "T" }])], ["T"]);
});

test("9. the family chart's marks and the folded cooling line", () => {
  const f = { sparkFrom: NOW - 24 * 300, startedAt: NOW - 20 * 60, post: { at: NOW - 26 * 60 } };
  const m = D.chartMarks(f, 300, 600);
  // the start in bucket 20 of 24 (index 20), the post 1.2 buckets earlier
  assert.equal(m.start, Math.round(((2 + (20 * 596) / 23) / 600) * 1000) / 10);
  assert.ok(m.post! < m.start!);
  assert.deepEqual(D.chartMarks({ ...f, post: { at: NOW - 3 * 3600 } }, 300).post, null, "outside the 2 h: no mark");
  assert.deepEqual(D.chartMarks({ ...f, post: null }, 300).post, null);
  assert.deepEqual(D.chartMarks({ ...f, sparkFrom: undefined }, 300), { start: null, post: null }, "an older server without sparkFrom");
  assert.equal(D.chartMarks({ ...f, startedAt: NOW - 60 }, 300, 600).start, Math.round(((598) / 600) * 1000) / 10, "the current bucket sits on the last point");
  const fam = { parent: { mint: "P", name: "Fiona", symbol: "FIONA", image: null, isCoin: true }, startedAt: NOW - 83 * 60, peakRatio: 19.2 } as WakeFamily;
  assert.equal(D.coolingLine(fam, NOW), "$FIONA · cooling · started 1 h 23 min ago · down from 19x");
  assert.match(D.familyChartLabel({ ...fam, spark: [1, 2], baseline: 1, post: post({ at: NOW - 26 * 60 }), sparkFrom: NOW - 24 * 300, startedAt: NOW - 20 * 60 } as WakeFamily & { sparkFrom: number }, 300, NOW),
    /normal is about 1\. Buying jumped here: the wake-up started 20 min ago\. The linked post was posted here, 26 min ago$/);
});

test("10. Trending: held like the families; the parent tag and the family pill", () => {
  const tr = (mint: string, o: Partial<TrendRow> = {}): TrendRow => ({ ...row(mint), parent: { mint: "PAR", symbol: "FIONA", image: null }, family: null, ...o });
  const shown = D.trendRows({ rows: [tr("A"), tr("B"), tr("A")] }, []);
  assert.deepEqual(shown.map((r) => r.mint), ["A", "B"], "a repeated row makes no second row");
  const fresh = { rows: [tr("C"), tr("B", { buyers5m: 99 })] };
  assert.deepEqual(D.trendRows(fresh, shown, false).map((r) => r.mint), ["C", "B"], "idle: the server's order");
  const held = D.trendRows(fresh, shown, true);
  assert.deepEqual(held.map((r) => [r.mint, !!r.left]), [["A", true], ["B", false], ["C", false]], "in use: nothing moves, a new row goes last");
  assert.equal(D.LEFT_PILL, "No longer listed", "the words a dropped row shows (TrendTags), as the cards do");
  assert.equal(held[1].buyers5m, 99);
  assert.equal(D.trendRows(null, shown, false).length, 0);
  assert.equal(D.parentTag(tr("A")), "under $FIONA");
  assert.equal(D.parentTag(tr("A", { parent: null })), null);
  assert.equal(D.parentTag(tr("A", { parent: { mint: "Par1111111111111111111111111111111111111111", symbol: null, image: null } }))?.startsWith("under Par1"), true);
  assert.deepEqual(["live", "cooling", null].map((f) => D.familyPill({ family: f as TrendRow["family"] })), ["waking up", "cooling", null]);
  assert.equal(D.emptyTrending("5m"), "Nothing is being bought in the last 5 min.");
  assert.equal(D.emptyTrending("1h"), "Nothing is being bought in the last hour.");
  assert.equal(D.emptyTrending("1m"), "Nothing is being bought in the last minute.");
});

test("11. the stored timeframe, tab and buy slot: defaults, bad values and blocked storage", () => {
  assert.deepEqual(["1m", "5m", "30m", "1h", "15m", null, "", 5].map(D.parseTf), ["1m", "5m", "30m", "1h", "5m", "5m", "5m", "5m"]);
  assert.deepEqual(["trending", "waking", "x", null].map(D.parseTab), ["trending", "waking", "waking", "waking"]);
  assert.deepEqual(["0", "1", "2", "3", "-1", "1.5", "", null, 2].map(D.parseSlot), [0, 1, 2, 0, 0, 0, 0, 0, 0]);
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
  assert.equal(D.readPref(() => store, D.TF_KEY, D.parseTf), "5m");
  D.writePref(() => store, D.TF_KEY, "1h");
  assert.equal(D.readPref(() => store, D.TF_KEY, D.parseTf), "1h");
  // localStorage itself throws (blocked site data), or its calls do: the default, and nothing thrown
  const boom = () => { throw new Error("SecurityError"); };
  assert.equal(D.readPref(boom, D.TAB_KEY, D.parseTab), "waking");
  assert.doesNotThrow(() => D.writePref(boom, D.TAB_KEY, "trending"));
  const bad = { getItem: boom, setItem: boom };
  assert.equal(D.readPref(() => bad, D.SLOT_KEY, D.parseSlot), 0);
  assert.doesNotThrow(() => D.writePref(() => bad, D.SLOT_KEY, "2"));
  assert.equal(D.readPref(() => null, D.TF_KEY, D.parseTf), "5m");
  assert.deepEqual([D.TF_KEY, D.TAB_KEY, D.SLOT_KEY], ["spore:dsc-tf", "spore:dsc-tab", "spore:dsc-slot"]);
  assert.deepEqual(D.TFS, ["1m", "5m", "30m", "1h"]);
});

test("12. the new words stay neutral: measured facts, a post only in time order, never advice", () => {
  const lines = [
    ...D.safetyChips({ devPct: 12, top10Pct: 60, sniperPct: 25, state: "ok" }).flatMap((c) => [c.text, c.title]),
    ...D.safetyChips({ devPct: null, top10Pct: null, sniperPct: null, state: "pending" }).flatMap((c) => [c.text, c.title]),
    D.postLead(post(), null, NOW), D.postLead(post({ lead: -600 }), null, NOW), D.postLead(post({ lead: 0 }), null, NOW), D.postBlock(post(), null, NOW).linked,
    D.footLine(1, 2, 3) ?? "", D.DUST_TITLE, D.emptyTrending("5m"), D.trendingSub("30m"), D.coinSparkLabel({ first: 1, last: 2 }), D.coolingLine({ parent: { mint: "P", name: null, symbol: "X", image: null, isCoin: true }, startedAt: NOW - 600, peakRatio: 9 }, NOW),
    D.startMarkTitle(NOW - 60, NOW), D.postMarkTitle(NOW - 60, NOW), D.familyPill({ family: "live" }) ?? "", D.parentTag({ parent: { mint: "P", symbol: "X", image: null } }) ?? "", ...Object.values(D.TF_TITLE), D.buyLabel(0.5),
  ];
  for (const l of lines) assert.doesNotMatch(l, /because|reason|driv|caus|thanks to|due to|moon|should|predict|expect|will |hot|trend|opportunit|recommend|good|likely|rise|pump|safe|risk|danger|scam|rug/i, l);
});

test("13. api.discover, api.discoverOf and api.trending: tf in the URL only when given", async () => {
  const urls: string[] = [], was = globalThis.fetch;
  globalThis.fetch = (async (url: string) => { urls.push(url); return new Response(JSON.stringify({ asOf: NOW, tf: "1h", rows: [], bucketS: 300, families: [] }), { status: 200, headers: { "content-type": "application/json" } }); }) as typeof fetch;
  try {
    await api.discover();
    await api.discover("1h");
    await api.discoverOf("Par1", "30m");
    const t = await api.trending("1m");
    await api.trending();
    assert.deepEqual(t.rows, []);
    assert.deepEqual(urls, ["/api/discover", "/api/discover?tf=1h", "/api/discover/Par1?tf=30m", "/api/trending?tf=1m", "/api/trending"]);
  } finally { globalThis.fetch = was; }
});
