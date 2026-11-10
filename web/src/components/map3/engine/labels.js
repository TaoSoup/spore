// FINAL POLISH (2026-10-21, LANES.md section 14): one label per ticker in view; names printed inside discs big enough
// for them; only the focused family is named when one owns the view.
// labels.js: every DOM surface of the map itself. Map labels (planets, children, generation tags, dust caption, editorial
// callouts, event toasts) placed on a 64 px screen grid with Imhof candidates, hysteresis and hairline leaders; the tooltip.
// (map3 port) Changed from the prototype:
//   - elements live in the layers the engine created (S.layers.labels / leaders / tip); no ids, no document-level keys.
//   - the HUD is the app's: title / crumb, legend, stats line, home button, search and the loading bar are gone. readHud()
//     reads S.obstacles (the page's chrome rects, set through setInset); labels and leaders avoid them.
//   - updateStats(counts, heatAt, status) keeps two jobs: the 'Most active in the last hour' callout and the canvas
//     aria-label.
//   - planet label second line '<tag> · N coins' (the app's dominance tag, S.tagOf(topMint)), else 'N coins'; setTags()
//     replaces the tag function and remeasures. Dust caption '+N smaller families · X% of <locked value | market cap>'.
//   - tooltip: 'Family' row 'N coins · <tag>' (final fix: the mode word wrapped it); the logo <img> only when the app's loader has
//     the image (S.images.ready), with its error listener through S.life; never shown for the selected coin; phone dock
//     buttons go through S.motion.tapAction (the click rule) and S.motion.clearHover.
//   - fonts: the site's Geist / Geist Mono (13 / 12 / 11 px 500/600; 10 px mono 400/500); remeasured on fonts.ready and
//     on 'loadingdone'.
//   - the live child label class is 'lv' (the app has a global .live); highlight: a child label of a coin that does not
//     match, and a planet label / gen tag / callout of a family with no match, get .dim.
//
// EXPORTS
//   fmtTicker(sym)        '$' + symbol with any leading '$' stripped, cut at 14 chars with '…'
//   buildLabels(S): Promise   awaits fonts (1.5 s race), builds pools. Fills S.labels:
//     layoutLabels()                 place every label for the current S.cam
//     readHud()                      re-read the obstacles (S.obstacles) labels avoid
//     showTip(i, sx, sy), hideTip()  tooltip for coin i at a container point (CSS px); phone = docked card
//     updateStats(counts, heatAt, status?)   'Most active' callout + canvas aria-label
//     setTags(tagOf), setHl()        the dominance tags / the highlight mask changed
//     toast(coin | {x, y, r, sym}, text, ms)   event labels ('new · $T', '$T +$12k')
//     ready()                        first frame is about to render
//     titles(), taggedTitles(), labelCount(), drawnCount(), tipInfo()   (reads for EngineDebug)
//   Debug: S.debugFns.labels()
import { TOK, FONT, heatClass } from "./tokens.js";
import { fmtN, sharePct, fmtUsd, smooth, TAU } from "./util.js";
// (family-all) a capped asset family's TRUE size (f.size = drawn members + ghost, data.js) on the planet label, the tooltip's
// family row, the pinned name and the canvas aria-label; the dust tooltip and the pinned name of a hovered / selected speck
import { DUST0 } from "./swarm.js";

// ---------- formatting ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// (round 2 final) ticker hygiene: symbols are user data. Pictographs / emoji (no glyph in the site faces: they rendered as
// '$(' fragments) are stripped; a slur is never printed on the map (masked in the tooltip).
const PICTO = /[\p{Extended_Pictographic}\u{FE0F}\u{FE0E}\u{200D}\u{20E3}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}]/gu;
const SLUR = /n[i1!|l]gg|f[a@4]gg?[o0e]t|\bk[i1]ke|ch[i1]nk|tr[a@]nn(y|ie)|\bsp[i1]c\b/i;
const blockedSym = (s) => SLUR.test(String(s ?? ""));
const cleanSym = (s) => String(s ?? "").replace(/^\$+/, "").replace(PICTO, "").replace(/\s+/g, " ").trim();
const unlabelable = (s) => blockedSym(s) || !/[\p{L}\p{N}]/u.test(cleanSym(s));   // never placed as a map label
const tickerBody = (s) => { const c = cleanSym(s); const b = [...(blockedSym(s) ? (c[0] || "?") + "•••" : c || "?")]; return b.length > 14 ? b.slice(0, 13).join("") + "…" : b.join(""); };
export const fmtTicker = (s) => "$" + tickerBody(s);
const tickerHTML = (s) => `<span class="d">$</span>${esc(tickerBody(s))}`;
const fmtCount = (n) => n >= 1e4 ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k" : fmtN(n);
const shortMint = (m) => m && m.length > 10 ? m.slice(0, 4) + "…" + m.slice(-4) : (m || "–");
// (final polish) one unit style everywhere (30m · 3h · 24h), and durations as '3h 12m', never '3.2 h'
const dur = (a) => a < 3600 ? `${Math.max(1, Math.round(a / 60))}m` : `${Math.floor(a / 3600)}h${Math.round((a % 3600) / 60) ? " " + Math.round((a % 3600) / 60) + "m" : ""}`;
const agoChip = (a) => !(a >= 0) || a === Infinity ? "no trades 24h" : a < 60 ? "just now" : `${dur(a)} ago`;
const SEP = '<span class="sep"> · </span>';
// (map3 port) a dominance tag is app data: plain text, short
const tagText = (v) => { if (v == null) return null; const s = String(v).trim(); return s ? s.slice(0, 12) : null; };

// ---------- labels ----------
export async function buildLabels(S) {
  const { N, fams, planets, dust, famOf, sym, img, mint, mc, n24, gen, R, X, Y, maxShare, dustShare, W, H, phone, toS, toW, U } = S;
  // (galaxy) the look: planet titles 'N · 38%', caption '+N small trees', gen tags on every big family's generation bands
  // (layout.js sets f.bandOut under the galaxy); undefined (an engine without S.look) = flat, every flat string unchanged
  const G = S.look === "galaxy";
  const life = S.life;

  // fonts first: every width below is measured with the real faces (1.5 s race), remeasured on fonts.ready.
  // (map3 port) the site's Geist / Geist Mono; index.html already loads them, so this usually resolves at once
  const SANS = FONT.sans, MONO = FONT.mono;
  const tL0 = performance.now();
  try {
    const fonts = typeof document !== "undefined" ? document.fonts : null;
    if (fonts && typeof fonts.load === "function") {
      await Promise.race([
        Promise.all([`600 13px ${SANS}`, `500 13px ${SANS}`, `500 11px ${SANS}`, `600 12px ${SANS}`, `500 12px ${SANS}`, `400 10px ${MONO}`, `500 10px ${MONO}`].map((f) => fonts.load(f).catch(() => null))),
        new Promise((r) => life.timeout(r, 1500)),
      ]);
    }
  } catch { /* fallbacks measure first; remeasured below */ }
  if (S.dead) return;
  S.debug.map.labelsFontMs = Math.round(performance.now() - tL0);
  const mctx = document.createElement("canvas").getContext("2d");
  const mw = (s, font, ls = 0) => { mctx.font = font; return mctx.measureText(s).width + ls * [...s].length; };
  const F = {
    A: [`500 13px ${SANS}`, `600 13px ${SANS}`, -0.065], P: [`500 12px ${SANS}`, `600 12px ${SANS}`, -0.06], B: [`500 11px ${SANS}`, `500 11px ${SANS}`, 0],
    kid: [`500 11px ${SANS}`, `500 11px ${SANS}`, 0], pin: [`600 15px ${SANS}`, `600 15px ${SANS}`, -0.075], mono10: `400 10px ${MONO}`, gen: `${G ? 600 : 500} 10px ${MONO}`, a1: `500 11px ${SANS}`,
  };
  const tickW = (s, f) => { const b = tickerBody(s); return mw("$", f[0]) + mw(b, f[1], f[2]); };
  const HALO = { 13: 3, 12: 3, 11: 2.5, 10: 2 };

  const labelsEl = S.layers.labels;
  const mk = (cls, html) => { const e = document.createElement("div"); e.className = "lb " + cls; e.innerHTML = html; labelsEl.appendChild(e); return e; };
  const snap = (v) => Math.round(v * S.DPR) / S.DPR;
  let layN = 0;
  // (integrator, round 2) coin dragging: the slot every shown label had when the drag began (see layoutLabels)
  let dragMem = null;
  const showL = (L, x, y) => {
    x = snap(x); y = snap(y);
    if (L.x !== x || L.y !== y) { L.e.style.transform = `translate(${x}px,${y}px)`; L.x = x; L.y = y; }
    if (!L.on) { L.on = true; L.e.classList.add("on"); L.tOn = performance.now(); fadeKick(); }
    L.lay = layN;
  };
  const hideL = (L) => { if (L.on) { L.on = false; L.e.classList.remove("on"); } L.slot = null; L.want = 0; L.leader = null; };
  const setO = (L, o) => { o = Math.round(o * 40) / 40; if (L.o !== o) { L.o = o; L.e.style.setProperty("--o", o); } };
  const setCls = (L, key, cls) => { if (L[key] !== cls) { if (L[key]) L.e.classList.remove(L[key]); if (cls) L.e.classList.add(cls); L[key] = cls; } };

  // (round 2 final) a family's visible radius (world u): the 90th-percentile member distance from its top (+ R), read
  // from the designed layout once
  const visRc = new Map();
  const visR = (f) => {
    let v = visRc.get(f.id);
    if (v === undefined) { const t = f.top, d = f.members.map((j) => Math.hypot(X[j] - X[t], Y[j] - Y[t]) + R[j]).sort((a, b) => a - b); v = d.length > 1 ? d[Math.floor(0.9 * (d.length - 1))] : R[t]; visRc.set(f.id, v); }
    return v;
  };
  const sizeOf = (f) => (Number.isFinite(f.size) ? f.size : f.members.length);
  // ---------- planets: one pooled element, variants measured up front ----------
  // (map3 port) second line: '<tag> · 1,481 coins' with the app's dominance tag for the family top, else '1,481 coins'
  const tagOfTop = (f) => { try { return tagText(S.tagOf(mint[f.top])); } catch { return null; } };
  const planetLab = planets.map((f) => {
    const s = sym[f.top];
    const L = { kind: "pl", f, fam: f.id, own: f.top, e: mk("pl", ""), on: false, slot: null, want: 0, o: 1, tag: null };
    L.fill = () => {
      const tag = tagOfTop(f), n = `${fmtCount(sizeOf(f))} coins`;
      L.tag = tag;
      if (G) {   // galaxy: '1,507 · 40%' (coins, then the dominance tag), '1,507 coins' without a tag
        const c = fmtCount(sizeOf(f)), sh = tag ?? (Number.isFinite(f.share) ? sharePct(f.share) : null);   // (lead) share for every planet, as the reference
        L.stTxt = sh ? `${c} · ${sh}` : n;
        L.e.innerHTML = `<div class="t">${tickerHTML(s)}</div><div class="s">${sh ? `${esc(c)}${SEP}${esc(sh)}` : n}</div>`;
        return;
      }
      L.stTxt = tag ? `${tag} · ${n}` : n;
      L.e.innerHTML = `<div class="t">${tickerHTML(s)}</div><div class="s">${tag ? `${esc(tag)}${SEP}${n}` : n}</div>`;
    };
    L.measure = () => {
      const sw = mw(L.stTxt, F.mono10) + HALO[10];
      L.v = {
        A: { w: tickW(s, F.A) + HALO[13], h: 16 }, P: { w: tickW(s, F.P) + HALO[12], h: 15 }, B: { w: tickW(s, F.B) + HALO[11], h: 14 }, sw,
      };
    };
    L.fill(); L.measure();
    return L;
  });
  // children: lazily pooled by coin index (LRU-trimmed)
  const kidPool = new Map();
  const kidL = (i) => {
    let L = kidPool.get(i);
    if (!L) {
      L = { kind: "kid", i, fam: famOf[i], own: i, e: mk("kid", `<div class="t">${tickerHTML(sym[i])}</div><div class="s">${esc(fmtUsd(mc[i]))}</div>`), on: false, slot: null, want: 0, o: 1 };
      L.measure = () => { L.w1 = tickW(sym[i], F.kid) + HALO[11]; L.w2 = Math.max(L.w1, mw(fmtUsd(mc[i]), F.mono10) + HALO[10]); };
      L.measure(); kidPool.set(i, L);
    }
    L.used = layN;
    return L;
  };
  const trimKids = () => {
    if (kidPool.size <= 360) return;
    const old = [...kidPool.values()].filter((L) => !L.on).sort((a, b) => a.used - b.used);
    for (const L of old.slice(0, kidPool.size - 300)) { L.e.remove(); kidPool.delete(L.i); }
  };
  // generation tags: pooled per (family, gen)
  const genPool = new Map();
  const genL = (f, g, count) => {
    const key = f.id * 16 + g; let L = genPool.get(key);
    if (!L) {
      const t = `GEN ${g} · ${fmtCount(count)}`;
      L = { kind: "gen", fam: f.id, own: -1, g, e: mk("gen al-c", esc(t)), on: false, o: 1, t };
      L.measure = () => { L.w = mw(t.toUpperCase(), F.gen, 0.8) + HALO[10]; L.h = 12; };
      L.measure(); genPool.set(key, L);
    }
    return L;
  };
  // dust caption (map3 port: the size mode's word)
  const capText = G ? `+${fmtN(dust.length)} small trees · ${sharePct(dustShare)} of ${S.modeWord}` : `+${fmtN(dust.length)} smaller families · ${sharePct(dustShare)} of ${S.modeWord}`;
  const capL = { kind: "cap", fam: -2, own: -1, e: mk("cap al-c", capText.replace(" · ", SEP)), on: false, o: 1 };
  // (repair) QA: why the caption was (not) placed in the last layout pass: __sporeMap.call("capDebug")
  const capDbg = { gate: null, place: null }; S.debugFns.capDebug = () => ({ ...capDbg });
  capL.measure = () => { capL.w = mw(capText, F.mono10) + HALO[10]; capL.h = 12; };
  capL.measure();
  // editorial annotations (desktop >= 1024, overview only)
  const annL = [0, 1].map(() => ({ kind: "ann", fam: -3, own: -1, e: mk("ann", ""), on: false, o: 1, w: 0, h: 26, sig: "" }));
  const setAnn = (L, l1, l2) => {
    const sig = l1 + "|" + l2; if (L.sig === sig) return; L.sig = sig;
    L.e.innerHTML = `<div class="a1">${esc(l1)}</div><div class="a2">${l2}</div>`;
    L.w = Math.max(mw(l1, F.a1) + HALO[11], mw(l2.replace(/<[^>]+>/g, ""), F.mono10) + HALO[10]);
  };
  // (focus lane) the pinned name: the focused (pulsing) coin's, else the selected coin's. Placed first in every pass, under
  // its sphere (above it when there is no room below), never dimmed (map3.css .m3-pin); the coin's own title / child label
  // steps aside for it. Line 2: a family top's 'N coins · share', any other coin's market cap.
  const pinL = { kind: "pin", fam: -3, own: -1, e: mk("pin m3-pin st al-c", ""), on: false, o: 1, i: -1, w: 0, h: 30, sig: "" };
  const fillPin = (i) => {
    let l2, s;
    if (i >= DUST0) {   // (family-all) a speck: its ticker and market cap
      const d = S.swarm && S.swarm.tip(i); if (!d) return false;
      s = d.symbol || String(d.mint).slice(0, 4); l2 = fmtUsd(d.mcapUsd);
    } else {
      const f = fams[famOf[i]];
      s = sym[i];
      if (f && f.top === i) {
        const pl = f.planet ? planetLab.find((L) => L.f === f) : null;
        l2 = pl && pl.stTxt ? pl.stTxt : `${fmtCount(sizeOf(f))} coins${Number.isFinite(f.share) && f.share > 0 ? ` · ${sharePct(f.share)}` : ""}`;
      } else l2 = fmtUsd(mc[i]);
    }
    const sig = i + "|" + l2 + "|" + s; if (pinL.sig === sig) return true;
    pinL.sig = sig; pinL.i = i;
    pinL.e.innerHTML = `<div class="t">${tickerHTML(s)}</div><div class="s">${l2.split(" · ").map(esc).join(SEP)}</div>`;
    pinL.w = Math.max(tickW(s, F.pin) + HALO[13], mw(l2, F.mono10) + HALO[10]); pinL.h = 30;
    return true;
  };
  let active = null;   // { f, n } most active planet family in the last hour (sum of heat.t1h)
  const computeActive = () => {
    const h = S.heat; active = null;
    if (!h || !Array.isArray(h.t1h) || !h.mint) return;
    const sums = new Float64Array(fams.length);
    for (let r = 0; r < h.mint.length; r++) { const i = S.mintIdx?.get(h.mint[r]); if (i !== undefined) sums[famOf[i]] += +h.t1h[r] || 0; }
    for (const f of planets) if (sums[f.id] > 0 && (!active || sums[f.id] > active.n)) active = { f, n: sums[f.id] };
  };
  computeActive();

  // remeasure everything once the real faces are in (first measure may have used fallbacks)
  const remeasure = () => { if (S.dead) return; for (const L of planetLab) L.measure(); for (const L of kidPool.values()) L.measure(); for (const L of genPool.values()) L.measure(); capL.measure(); for (const L of annL) L.sig = ""; if (readyDone) layoutLabels(); };
  try { document.fonts?.ready?.then(() => { if (!S.dead) remeasure(); }, () => {}); } catch { /* ignore */ }
  // faces that arrive after this point remeasure too (S.life removes the listener with the engine)
  try { if (document.fonts) life.on(document.fonts, "loadingdone", remeasure); } catch { /* ignore */ }

  let readyDone = false, lastChips = [];
  // ---------- screen grids: hard obstacles/labels + soft reservations (hysteresis) ----------
  const CELL = 64, PAD = 3;
  const items = [], grid = new Map(), soft = [], softGrid = new Map();
  let seen = new Int32Array(4096), stamp = 1;
  const gkey = (gx, gy) => (gx + 512) * 4096 + (gy + 512);
  const gAdd = (G, arr, it) => {
    const id = arr.length; arr.push(it);
    const x0 = Math.floor(it.x0 / CELL), x1 = Math.floor(it.x1 / CELL), y0 = Math.floor(it.y0 / CELL), y1 = Math.floor(it.y1 / CELL);
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) { const k = gkey(gx, gy); let a = G.get(k); if (!a) G.set(k, (a = [])); a.push(id); }
  };
  const addRect = (x0, y0, x1, y1, kind, own = -1) => gAdd(grid, items, { x0, y0, x1, y1, kind, own });
  const addCirc = (cx, cy, r, kind, own) => gAdd(grid, items, { x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r, cx, cy, r, kind, own });
  const hits = (it, X0, Y0, X1, Y1) => {
    if (X0 >= it.x1 || X1 <= it.x0 || Y0 >= it.y1 || Y1 <= it.y0) return false;
    if (it.r === undefined) return true;
    const dx = Math.max(X0 - it.cx, 0, it.cx - X1), dy = Math.max(Y0 - it.cy, 0, it.cy - Y1);
    return dx * dx + dy * dy < it.r * it.r;
  };
  const query = (G, arr, b, pad, test) => {
    const X0 = b.x0 - pad, Y0 = b.y0 - pad, X1 = b.x1 + pad, Y1 = b.y1 + pad;
    if (arr.length > seen.length) seen = new Int32Array(arr.length * 2);
    stamp++;
    for (let gx = Math.floor(X0 / CELL); gx <= Math.floor(X1 / CELL); gx++) for (let gy = Math.floor(Y0 / CELL); gy <= Math.floor(Y1 / CELL); gy++) {
      const a = G.get(gkey(gx, gy)); if (!a) continue;
      for (const id of a) { if (seen[id] === stamp) continue; seen[id] = stamp; const it = arr[id]; if (hits(it, X0, Y0, X1, Y1) && test(it)) return true; }
    }
    return false;
  };
  const hardHit = (b, own) => query(grid, items, b, PAD, (it) => own < 0 || it.own !== own);
  // density: a child label may not blanket a seed head; it is refused when it covers >= 2 small bubbles (2.5-6 px)
  const small = [], smallGrid = new Map();
  const dense = (b, own) => { let n = 0; query(smallGrid, small, b, 0, (it) => it.own !== own && ++n >= 2); return n >= 2; };
  const softHit = (b, L) => soft.length > 0 && query(softGrid, soft, b, PAD, (it) => it.L !== L);

  // ---------- Imhof candidates ----------
  const DIRS_PL = ["E", "NE", "SE", "S", "N", "W", "NW", "SW"], DIRS_KID = ["E", "W", "S", "N"];
  const ALIGN = { E: "l", NE: "l", SE: "l", S: "c", N: "c", W: "r", NW: "r", SW: "r", C: "c" };
  const D45 = Math.SQRT1_2;
  const boxFor = (d, ax, ay, r, o, w, h) => {
    let x, y; const q = (r + o) * D45, v = r + Math.max(2, o - 2) + (o > 6 ? o - 6 : 0);
    switch (d) {
      case "E": x = ax + r + o; y = ay - h / 2; break;
      case "W": x = ax - r - o - w; y = ay - h / 2; break;
      case "S": x = ax - w / 2; y = ay + v; break;
      case "N": x = ax - w / 2; y = ay - v - h; break;
      case "C": x = ax - w / 2; y = ay - h / 2; break;
      case "NE": x = ax + q; y = ay - q - h; break;
      case "SE": x = ax + q; y = ay + q; break;
      case "NW": x = ax - q - w; y = ay - q - h; break;
      default: x = ax - q - w; y = ay + q;   // SW
    }
    return { x0: x, y0: y, x1: x + w, y1: y + h };
  };
  const leaderFor = (ax, ay, r, b) => {
    const px = Math.max(b.x0, Math.min(ax, b.x1)), py = Math.max(b.y0, Math.min(ay, b.y1));
    const dx = px - ax, dy = py - ay, len = Math.hypot(dx, dy);
    if (len < r + 6) return null;
    const ux = dx / len, uy = dy / len, l = len - r - 3 - 2;
    if (l > 40) return false;
    return [ax + ux * (r + 3), ay + uy * (r + 3), px - ux * 2, py - uy * 2];
  };
  // does a leader polyline cross a chip, a bubble or a label (own chip excluded)? sampled every 5 px
  const pathHit = (pts, own) => {
    for (let j = 0; j + 3 < pts.length; j += 2) {
      const x0 = pts[j], y0 = pts[j + 1], x1 = pts[j + 2], y1 = pts[j + 3], n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 5));
      for (let s = 0; s <= n; s++) { const x = x0 + (x1 - x0) * s / n, y = y0 + (y1 - y0) * s / n; if (query(grid, items, { x0: x - 1, y0: y - 1, x1: x + 1, y1: y + 1 }, 0, (it) => it.own !== own && it.kind !== "hud")) return true; }
    }
    return false;
  };
  // (final fix) planet colonies on screen: the family's visible disc (visR) around its top, rebuilt each pass. A planet label,
  // its leader, a callout and its elbow never sit on ANOTHER family's dots (at the app's smaller fit scale, labels kept their
  // size and $EXFIL's label had landed inside $Kimchi's colony); the label is dropped rather than led into a foreign colony.
  // A label may graze a colony's sparse rim (its outer COLONY_RIM, at least 10 px), never reach further in; a leader line
  // may not cross a colony at all (4 px of slack).
  const colonies = [], COLONY_RIM = 0.3;
  const inner = (c) => c.r - Math.max(10, COLONY_RIM * c.r);
  const boxInColony = (b, fam) => {
    for (const c of colonies) {
      if (c.fam === fam) continue;
      const dx = Math.max(b.x0 - c.cx, 0, c.cx - b.x1), dy = Math.max(b.y0 - c.cy, 0, c.cy - b.y1), ri = inner(c);
      if (ri > 0 && dx * dx + dy * dy < ri * ri) return true;
    }
    return false;
  };
  const pathInColony = (pts, fam) => {
    for (let j = 0; j + 3 < pts.length; j += 2) {
      const x0 = pts[j], y0 = pts[j + 1], x1 = pts[j + 2], y1 = pts[j + 3], n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 4));
      for (let s = 0; s <= n; s++) {
        const x = x0 + (x1 - x0) * s / n, y = y0 + (y1 - y0) * s / n;
        for (const c of colonies) { const ri = c.r - 4; if (c.fam !== fam && ri > 0 && (x - c.cx) ** 2 + (y - c.cy) ** 2 < ri * ri) return true; }
      }
    }
    return false;
  };
  // place L around anchor (ax, ay, radius r); returns true when shown. L.w/L.h must be current. colFam >= 0: the label of
  // that family's planet (foreign colonies are obstacles for its box and its leader).
  function tryPlace(L, ax, ay, r, dirs, o, w, h, useDense = false, colFam = -1) {
    const Wd = W(), Hd = H();
    // (integration) an anchor under the HUD (title, legend, stats ...) gets no label: its leader would run through the chrome
    for (const q of hudRects) if (ax >= q.x0 && ax <= q.x1 && ay >= q.y0 && ay <= q.y1) return false;
    const order = [];
    if (L.slot && L.slot.disp === 0) order.push(L.slot);
    for (const disp of [0, 18, 30]) { for (const d of dirs) order.push({ d, disp }); if (disp === 0 && L.slot && L.slot.disp > 0) order.push(L.slot); }
    let softBlocked = null;
    for (const s of order) {
      const b = boxFor(s.d, ax, ay, r, o + s.disp, w, h);
      if (b.x0 < 2 || b.y0 < 2 || b.x1 > Wd - 2 || b.y1 > Hd - 2) continue;
      let ld = null;
      if (s.disp > 0) { ld = leaderFor(ax, ay, r, b); if (ld === false) continue; }
      if (hardHit(b, L.own) || (useDense && dense(b, L.own))) continue;
      if (colFam >= 0 && (boxInColony(b, colFam) || (ld && pathInColony(ld, colFam)))) continue;
      if (softHit(b, L)) { if (!softBlocked) softBlocked = { s, b, ld }; continue; }
      commit(L, s, b, ld); L.want = 0; return true;
    }
    if (softBlocked && ++L.want >= 2) { commit(L, softBlocked.s, softBlocked.b, softBlocked.ld); return true; }
    return false;
  }
  const placedBoxes = [];
  function commit(L, s, b, ld) {
    gAdd(grid, items, { ...b, kind: "lab", own: -1 });
    placedBoxes.push({ ...b, L });
    L.slot = s; L.leader = ld || null; L.box = b;
    setCls(L, "alc", "al-" + ALIGN[s.d]);
    showL(L, b.x0, b.y0);
  }
  const reserve = (L, b) => gAdd(softGrid, soft, { ...b, L });

  // ---------- page chrome (map3 port): the obstacles the app passes through setInset (container px) ----------
  let hudRects = [], hudRaw = [];
  const readHud = () => {
    hudRaw = (S.obstaclesRaw || []).map((r) => ({ ...r }));
    hudRects = (S.obstacles || []).map((r) => ({ ...r }));
  };

  // ---------- leaders: one 2D canvas at DPR ----------
  const lcv = S.layers.leaders, lctx = lcv?.getContext("2d");
  let lW = 0, lH = 0, lD = 0, lDirty = false;
  const LEAD = TOK.leaderA;
  function drawLeaders() {
    if (!lctx || S.dead) return false;
    const w = W(), h = H(), DPR = S.DPR;
    if (lW !== w || lH !== h || lD !== DPR) { lW = w; lH = h; lD = DPR; lcv.width = Math.round(w * DPR); lcv.height = Math.round(h * DPR); lcv.style.width = w + "px"; lcv.style.height = h + "px"; }
    const now = performance.now(), dimOn = dimState.on;
    const list = [];
    for (const p of placedBoxes) if (p.L.leader || p.L.elbow) list.push(p.L);
    if (!list.length && !lDirty) return false;
    lctx.setTransform(DPR, 0, 0, DPR, 0, 0); lctx.clearRect(0, 0, w, h);
    lctx.lineWidth = 0.75; lctx.lineCap = "round";
    let fading = false;
    for (const L of list) {
      const t = Math.min(1, (now - L.tOn) / 140); if (t < 1) fading = true;
      const e = 1 - (1 - t) ** 3;
      const a = LEAD * e * (L.o ?? 1) * ((dimOn && L.fam !== dimState.fam) || hlDimmed(L) ? TOK.labelDim : 1);
      if (a < 0.004) continue;
      lctx.strokeStyle = `rgba(231,236,233,${a.toFixed(3)})`;
      lctx.beginPath();
      const pts = L.elbow || L.leader;
      lctx.moveTo(pts[0], pts[1]); for (let j = 2; j < pts.length; j += 2) lctx.lineTo(pts[j], pts[j + 1]);
      lctx.stroke();
      if (L.elbow) { lctx.fillStyle = `rgba(231,236,233,${Math.min(1, a * 2.2).toFixed(3)})`; lctx.beginPath(); lctx.arc(pts[0], pts[1], 1.5, 0, TAU); lctx.fill(); }
    }
    lDirty = list.length > 0;
    return fading;
  }
  let fadeRaf = 0;
  function fadeKick() { if (fadeRaf || S.dead) return; const step = () => { fadeRaf = 0; if (drawLeaders()) fadeRaf = life.raf(step); }; fadeRaf = life.raf(step); }

  // ---------- hover dim (labels of other families to .35 while a family is hovered) ----------
  const dimState = { on: false, fam: -1 };
  // (map3 port) highlight: S.hlOn with S.hlBit(coin) and S.hlFam(famId) (motion.js setHighlight). A child label dims when
  // its coin does not match; a family's label (planet, gen tag, callout) when the family has no match; a toast by its coin
  const hlDimmed = (L) => {
    if (!S.hlOn) return false;
    if (L.kind === "kid") return !S.hlBit(L.i);
    if (L.kind === "evt") return L.own >= 0 ? !S.hlBit(L.own) : false;
    if (L.kind === "pl" || L.kind === "gen" || L.kind === "ann") return L.fam >= 0 && typeof S.hlFam === "function" ? !S.hlFam(L.fam) : false;
    return false;
  };
  // fam >= 0: a family's label; -2: the dust caption (dims with the dust); -3: an unassigned annotation (never dims)
  const applyDim = (L) => setCls(L, "dimc", (dimState.on && L.fam !== dimState.fam && L.fam !== -3) || hlDimmed(L) ? "dim" : "");
  // (round 2 final) event labels (births, whale trades): toast(coin | {x, y, r, sym}, text, ms). At most 4 at once, oldest
  // dropped. kind "evt"; ticker hygiene applies (a blocked ticker is masked).
  const toasts = [];
  function toast(who, text, ms = 2000) {
    if (!readyDone) return false;
    const i = Number.isInteger(who) ? who : -1, at = i < 0 && who && Number.isFinite(who.x) ? who : null;
    if (i < 0 && !at) return false;
    const s = i >= 0 ? sym[i] : who.sym || "";
    const html = `<div class="t">${text.startsWith("new") ? `<span class="ev">${esc(text)}</span> ${tickerHTML(s)}` : `${tickerHTML(s)} <span class="ev">${esc(text)}</span>`}</div>`;
    const L = { kind: "evt", fam: -3, own: i, e: mk("kid evt", html), on: false, slot: null, want: 0, o: 1 };
    L.w = mw("$", F.kid[0]) + mw(tickerBody(s) + " " + text, F.kid[1]) + HALO[11] + 4; L.h = 14;
    if (toasts.length >= 4) { const old = toasts.shift(); hideL(old.L); old.L.e.remove(); }
    toasts.push({ i, at, L, until: performance.now() + ms });
    layoutLabels(); life.timeout(() => { if (readyDone) layoutLabels(); }, ms + 30);
    return true;
  }
  const allLabels = function* () { yield* planetLab; yield* kidPool.values(); yield* genPool.values(); yield capL; yield* annL; for (const T of toasts) yield T.L; };
  let lastHoverI = -1;
  S.onFrame(() => {
    // hover dim, else (final polish) focus: when a family owns the view, the other families' labels recede too
    const hovOn = U.uHoverFam.value >= 0 && U.uDimMix.value > 0.02, focOn = !G && !hovOn && U.uFocusFam.value >= 0 && U.uFocusMix.value > 0.5;   // (fixer) galaxy: neighbours keep their titles lit
    const fam = hovOn ? U.uHoverFam.value : focOn ? U.uFocusFam.value : -1, on = hovOn || focOn;
    if (on !== dimState.on || (on && fam !== dimState.fam)) { dimState.on = on; dimState.fam = fam; for (const L of allLabels()) applyDim(L); fadeKick(); }
    if (S.hoverI !== lastHoverI) { lastHoverI = S.hoverI; if (readyDone) layoutLabels(); }
  });

  // ---------- stats (map3 port): the app owns the HUD; this keeps the 'Most active' callout and the canvas label ----------
  let stats = { counts: null, at: S.nowS || null, offline: false };
  const countsNow = () => { const c = [0, 0, 0, 0]; for (let i = 0; i < N; i++) c[heatClass(S.age[i])]++; return c; };
  const normCounts = (c) => Array.isArray(c) ? c : c && typeof c === "object" ? [c.live ?? c[0] ?? 0, c.cooling ?? c.cool ?? c[1] ?? 0, c.quiet ?? c[2] ?? 0, c.cold ?? c[3] ?? 0] : null;
  function renderStats() {
    const c = stats.counts || [0, 0, 0, 0], cv = S.layers.canvas;
    if (cv) cv.setAttribute("aria-label", `Spore map: ${fmtN(N + (S.ghostTotal || 0))} coins in ${fmtN(fams.length)} families; ${fmtN(c[0])} traded in the last 30 minutes`);
  }
  const updateStats = (counts, heatAt, status) => {
    const c = normCounts(counts);
    stats.offline = status === "offline" || c == null;
    if (c) stats.counts = c;
    if (heatAt) stats.at = heatAt;
    computeActive(); for (const L of annL) L.sig = "";
    renderStats();
  };

  // ---------- the layout pass ----------
  let lastShownKids = new Set(), knockSig = "", drawnN = 0;
  function layoutLabels() {
    if (S.dead || !readyDone) return;
    layN++;
    { const dr = S.drag, moving = !!(dr && (dr.active || dr.settling));
      if (moving && !dragMem) { dragMem = new Map(); for (const L of allLabels()) if (L.on && L.slot) dragMem.set(L, { ...L.slot }); }
      // (round 2 final) frozen from grab to rest (was: from release on): a label keeps its pre-drag slot and rides its
      // anchor rigidly, so nothing re-slots or crossfades while coins move
      if (dragMem) for (const [L, sl] of dragMem) { if (!L.slot || L.slot.d !== sl.d || L.slot.disp !== sl.disp) { L.slot = { ...sl }; L.want = 0; } }
      if (dragMem && !moving) dragMem = null; }
    const Wd = W(), Hd = H(), k = S.cam.k, k0 = S.overview.k0 || k, ph = phone();
    // (bubbles lane, look fix 2026-10-22) kB = the zoom relative to the FRAME fit (scene.js fitK0Frame), not to k0: k0 is cut
    // below the frame fit so every family stays in the overview, and the child budget / two-line switch keyed to k0 then
    // flipped at a smaller absolute scale than before (4x read as 2.2 px/u, budget 40 instead of 64)
    const kF = (S.debug && S.debug.map && S.debug.map.fitK0Frame) || k0, kB = k / kF;
    const overview = k <= 1.3 * k0, minWH = Math.min(Wd, Hd);
    items.length = 0; grid.clear(); soft.length = 0; softGrid.clear(); small.length = 0; smallGrid.clear(); placedBoxes.length = 0;
    for (const r of hudRects) addRect(r.x0, r.y0, r.x1, r.y1, "hud");

    // focused family: the family under the screen centre that fills >= 30 % of the short side (the gen-tag fallback)
    let focusF = null;
    if (k >= 1.3 * k0) { let best = Infinity; for (const f of fams) { if (f.cx === undefined || f.Rc * k < 0.3 * minWH) continue; const d = Math.hypot(f.cx - S.cam.x, f.cy - S.cam.y) / f.Rc; if (d < 1 && d < best) { best = d; focusF = f; } } }

    // planet chips (hard obstacles) + which planets are on screen
    const chipR = new Float32Array(planets.length), chipX = new Float32Array(planets.length), chipY = new Float32Array(planets.length), chipOn = new Uint8Array(planets.length);
    const chips = [];
    planets.forEach((f, j) => {
      const [sx, sy] = toS(f.cx, f.cy);
      const r = Math.max(R[f.top] * k, TOK.chipR(f.share, maxShare, ph));
      const ro = r + (r >= TOK.arcMinR && n24[f.top] > 0 ? TOK.arcGap + 2 : 0);
      chipR[j] = ro; chipX[j] = sx; chipY[j] = sy;
      if (sx + ro < -40 || sy + ro < -40 || sx - ro > Wd + 40 || sy - ro > Hd + 40) return;
      addCirc(sx, sy, ro, "chip", f.top); chips.push({ cx: sx, cy: sy, r });
      if (sx >= 0 && sy >= 0 && sx <= Wd && sy <= Hd) chipOn[j] = 1;   // label only chips whose centre is on screen
    });
    colonies.length = 0;
    planets.forEach((f, j) => {
      const cr = visR(f) * k; if (!(cr > chipR[j] + 4)) return;   // a colony no larger than its chip: the chip is the obstacle
      const [cx, cy] = toS(X[f.top], Y[f.top]);
      if (cx + cr < 0 || cy + cr < 0 || cx - cr > Wd || cy - cr > Hd) return;
      colonies.push({ cx, cy, r: cr, fam: f.id });
    });

    // on-screen coins: bubble obstacles (r >= 6 px incl. arc) and child-label candidates
    const [wx0, wy1] = toW(0, 0), [wx1, wy0] = toW(Wd, Hd);
    const showDust = S.dustExpand > 0.5;
    const obs = [], cand = [], smallI = [];
    const kidsOK = !overview, hov = S.hoverI >= 0 && S.hoverI < N ? S.hoverI : -1;   // (family-all) a hovered speck has no child label
    // (map3 port) drawn = coins drawn at >= 1 px in view (frameStats): the chips on screen + the coins visited here
    let drawn = 0; const sR = S.bubbles.screenR;
    for (let j = 0; j < planets.length; j++) if (chipOn[j]) drawn++;
    // (look fix) a small family's top is DRAWN at its 3-6 px floor once the field handed off (bubbles.js minPx), whatever its
    // layout radius: it is measured by that drawn radius (candidate gate, obstacle, label anchor), so the dust-family tops are
    // labelable at 4x as in the old locked view ($QQQx, $GIGA, $OTC ...). Planets stay chips; children keep R k.
    const drawnR = (i, f) => { const r0 = R[i] * k; return !G && !f.planet && i === f.top && typeof sR === "function" ? Math.max(r0, sR(i)) : r0; };   // flat only (galaxy untouched)
    const visit = (i) => {
      const f = fams[famOf[i]];
      if (f.planet ? i === f.top : !showDust) return;
      const x = X[i], y = Y[i]; if (x < wx0 || x > wx1 || y < wy0 || y > wy1) return;
      const r = drawnR(i, f);
      if (r >= 1 && (typeof sR !== "function" || sR(i) >= 1)) drawn++;
      if (r >= 6) obs.push(i); else if (r >= 2.5 && kidsOK) smallI.push(i);
      if (kidsOK && (r >= 3.5 || (r >= 3.0 && lastShownKids.has(i)))) cand.push(i);   // (final polish) 5 -> 3.5 px: the airier seed heads draw their coins smaller
    };
    const cellW = S.worldGrid?.cell || 24;
    // (focus lane) coins on the move (a held coin and its trailing chain) are visited by their live X/Y, not by the grid
    // cell they were bucketed in: obstacles and child labels follow them; the grid pass skips them so none counts twice
    const drm = S.drag, movingNow = !!(drm && (drm.active || drm.settling) && drm.nMoved > 0 && drm.moved);
    const movSet = movingNow ? new Set() : null;
    if (movSet) for (let q = 0; q < drm.nMoved; q++) { const i = drm.moved[q]; if (i >= 0 && i < N) movSet.add(i); }
    const visitG = movSet ? (i) => { if (!movSet.has(i)) visit(i); } : visit;
    // (local perf 2026-11-09) before the dust field hands off only the members of the planet families pass visit() (it skips
    // their tops and every dust family): walk those instead of every grid cell of the view (12k cells holding all 58k coins at
    // the overview of the full index, on every layout)
    if (!showDust) { for (const f of planets) { const m = f.members; for (let q = 0; q < m.length; q++) visitG(m[q]); } }
    else if (S.worldGrid && ((wx1 - wx0) / cellW) * ((wy1 - wy0) / cellW) < N / 2) S.worldGrid.forEachIn(wx0, wy0, wx1, wy1, visitG);
    else for (let i = 0; i < N; i++) visitG(i);
    if (movSet) for (const i of movSet) visit(i);
    if (obs.length > 3000) { obs.sort((a, b) => R[b] - R[a]); if (kidsOK) for (let j = 3000; j < obs.length; j++) smallI.push(obs[j]); obs.length = 3000; }   // overflow still counts for density
    for (const i of obs) { const [sx, sy] = toS(X[i], Y[i]); const r = drawnR(i, fams[famOf[i]]); addCirc(sx, sy, r + (r >= TOK.arcMinR && n24[i] > 0 ? TOK.arcGap + 2 : 1), "bub", i); }
    if (smallI.length > 4000) { smallI.sort((a, b) => R[b] - R[a]); smallI.length = 4000; }
    for (const i of smallI) { const [sx, sy] = toS(X[i], Y[i]), r = drawnR(i, fams[famOf[i]]); gAdd(smallGrid, small, { x0: sx - r, y0: sy - r, x1: sx + r, y1: sy + r, cx: sx, cy: sy, r: r * 0.9, own: i }); }
    drawnN = drawn;

    // soft reservations: last layout's slots, so a label keeps its place unless someone wants it twice
    const reserveL = (L, ax, ay, r, o, w, h) => { if (L.on && L.slot) reserve(L, boxFor(L.slot.d, ax, ay, r, o + L.slot.disp, w, h)); };

    // ---- 0. (focus lane) the pinned name: always placed, before everything else ----
    const fT = U.uFocusT, fC = U.uFocusCoin;
    // (family-all) dust indices: the focused / selected speck, else the hovered one (a speck has no other label)
    const isSpeck = (i) => i >= DUST0 && !!(S.swarm && S.swarm.mintAt(i));
    const focusing = !!(fT && fC && fT.value > 0 && fC.value >= 0 && (fC.value < N || isSpeck(fC.value)));
    const selI = S.motion && typeof S.motion.selected === "function" ? S.motion.selected() : -1;
    const pinI = focusing ? fC.value : selI >= 0 && (selI < N || isSpeck(selI)) ? selI : isSpeck(S.hoverI) ? S.hoverI : -1;
    let pinOn = false;
    if (pinI >= 0 && fillPin(pinI)) {
      const speck = pinI >= DUST0, sp = speck ? S.swarm.pos(pinI) : null;
      const [sx, sy] = speck ? (sp ? toS(sp[0], sp[1]) : [-1e4, -1e4]) : toS(X[pinI], Y[pinI]);
      // the drawn radius (bubbles.js drawnPx: seed-head shrink and px floors applied), else the layout radius
      let rr = speck ? Math.max(2, S.swarm.screenR(pinI)) : R[pinI] * k;
      if (!speck) try { if (typeof S.bubbles.drawnPx === "function") { const d = S.bubbles.drawnPx(pinI); if (d > 0) rr = d; } } catch { /* bubbles without drawnPx */ }
      const fp = speck ? null : fams[famOf[pinI]];
      if (fp && fp.planet && fp.top === pinI) { const j = planets.indexOf(fp); if (j >= 0) rr = Math.max(rr, chipR[j]); }
      rr += focusing ? 12 : 7;   // clear of the focus ring (rim + 4..8 px, pulsing) and of the selection ring
      const w = pinL.w, h = pinL.h;
      if (sx > -rr && sy > -rr && sx < Wd + rr && sy < Hd + rr && w > 0) {
        const x0 = Math.min(Math.max(4, sx - w / 2), Wd - 4 - w);
        let y0 = sy + rr;
        if (y0 + h > Hd - 4) y0 = sy - rr - h;
        y0 = Math.min(Math.max(4, y0), Hd - 4 - h);
        const b = { x0, y0, x1: x0 + w, y1: y0 + h };
        gAdd(grid, items, { ...b, kind: "lab", own: -1 }); placedBoxes.push({ ...b, L: pinL }); pinL.box = b;
        showL(pinL, x0, y0); setO(pinL, 1); pinOn = true;
      }
    }
    if (!pinOn) hideL(pinL);

    // ---- 1. planets: priority = share rank, live gets an 8-rank bonus; hovered first ----
    const budgetP = ph ? 8 : G ? 64 : 32;   // (final polish) 24 -> 32; galaxy: every planet carries its title (M labels all 60)
    const plOrder = [];
    planetLab.forEach((L, j) => { if (!chipOn[j]) return; const f = L.f; let p = f.rank - (f.age <= 1800 ? 8 : 0); if (hov === f.top) p = -1e9; plOrder.push({ L, j, p }); });
    plOrder.sort((a, b) => a.p - b.p);
    const plSpec = [];
    for (const { L, j } of plOrder) {
      const f = L.f, focused = f.Rc * k >= 0.3 * minWH;
      const tier = ph ? "P" : f.rank < 10 || focused ? "A" : "B";
      const st = ph ? k >= 1.6 * k0 : G || tier === "A";   // galaxy: the stat line on every planet, as the reference
      const v = L.v[tier], w = Math.max(v.w, st ? L.v.sw : 0), h = v.h + (st ? 12 : 0);
      plSpec.push({ L, j, tier, st, w, h });
      reserveL(L, chipX[j], chipY[j], chipR[j], 6, w, h);
    }
    let nP = 0;
    for (const p of plSpec) {
      const { L, j, tier, st, w, h } = p;
      if (pinOn && L.f.top === pinI) { hideL(L); continue; }   // (focus lane) the pinned name carries this title
      if (nP >= budgetP && hov !== L.f.top) { hideL(L); continue; }
      if (overview && !ph && L.f.rank >= (G ? 64 : 32 + 8)) { hideL(L); continue; }
      setCls(L, "tierc", "t" + tier); setCls(L, "stc", st ? "st" : "");
      L.w = w; L.h = h;
      if (tryPlace(L, chipX[j], chipY[j], chipR[j], DIRS_PL, 6, w, h, false, L.f.id)) { nP++; setO(L, 1); applyDim(L); } else hideL(L);
    }

    // ---- 2. generation tags: on the arc at the occupied angle nearest 12 o'clock, sliding +-36 deg ----
    const knocks = [], seenG = new Set();
    {
      const famsG = [];
      // (final polish) generation arcs and tags belong to the focused (or hovered) family only
      const tagFam = (dimState.on && dimState.fam >= 0) ? dimState.fam : U.uFocusFam.value >= 0 ? U.uFocusFam.value : focusF ? focusF.id : -1;
      // (galaxy) every family whose disc is >= 220 px gets its tags (rings are drawn on every planet at every zoom); flat: the focused one
      for (const f of fams) { if (!G && f.id !== tagFam) continue; if (f.cx === undefined || !f.bandIn || f.bandIn.length < 2 || f.Rc * k < 220) continue; const [sx, sy] = toS(f.cx, f.cy); const rr = f.Rc * k; if (sx + rr < 0 || sy + rr < 0 || sx - rr > Wd || sy - rr > Hd) continue; famsG.push({ f, d: Math.hypot(sx - Wd / 2, sy - Hd / 2) / rr }); }
      famsG.sort((a, b) => a.d - b.d);
      for (const { f } of famsG) {
        if (knocks.length >= 12) break;
        const o = smooth(220, 320, f.Rc * k);
        let info = S.links.genArcInfo(f.id);
        // (galaxy) the tag sits centred 1.2 u above the band's outer edge, at 12 o'clock when free (the slide below), full circle
        if (G && Array.isArray(f.bandOut) && f.bandOut.length > 1) info = f.bandOut.map((r, g) => ({ gen: g, r: (r || 0) + 1.2, spans: null })).filter((a) => a.gen >= 1 && a.r > 1.2);
        if (!info || !info.length) continue;          // no drawn arcs (links: < 2 gens, Rc < 30 u or < 40 members) -> no tags
        for (const g of info) {
          if (knocks.length >= 12) break;
          if (!(g.gen >= 1) || !(g.r > 0)) continue;
          const cnt = f.count?.[g.gen] ?? 0; if (!cnt) continue;
          const L = genL(f, g.gen, cnt);
          const spans = (g.spans && g.spans.length ? g.spans : [[0, TAU]]).map(([a0, a1]) => { let len = a1 - a0; if (len < 0) len += TAU; return [a0, Math.min(TAU, len)]; });
          const inSpan = (a) => spans.some(([a0, len]) => len >= TAU - 1e-6 || ((a - a0) % TAU + TAU) % TAU <= len);
          // nearest occupied angle to 12 o'clock (world angle PI/2; screen y is flipped by toS)
          let a12 = Math.PI / 2, bestD = Infinity;
          for (const [a0, len] of spans) {
            if (len >= TAU - 1e-6) { a12 = Math.PI / 2; bestD = 0; break; }
            const dt = ((Math.PI / 2 - a0) % TAU + TAU) % TAU;
            if (dt <= len) { a12 = Math.PI / 2; bestD = 0; break; }
            const d0 = TAU - dt, d1 = dt - len;
            if (d0 < bestD) { bestD = d0; a12 = a0; } if (d1 < bestD) { bestD = d1; a12 = a0 + len; }
          }
          let ok = false;
          for (let s = 0; s <= 20 && !ok; s++) {
            const step = s === 0 ? 0 : (s % 2 ? 1 : -1) * Math.ceil(s / 2) * (6 * Math.PI / 180);
            const a = a12 + step; if (s > 0 && !inSpan(a)) continue;
            const [sx, sy] = toS(f.cx + Math.cos(a) * g.r, f.cy + Math.sin(a) * g.r);
            const b = { x0: sx - L.w / 2, y0: sy - L.h / 2, x1: sx + L.w / 2, y1: sy + L.h / 2 };
            if (b.x0 < 2 || b.y0 < 2 || b.x1 > Wd - 2 || b.y1 > Hd - 2 || hardHit(b, -1) || dense(b, -1)) continue;
            gAdd(grid, items, { ...b, kind: "lab", own: -1 }); placedBoxes.push({ ...b, L }); L.box = b;
            showL(L, b.x0, b.y0); setO(L, o); applyDim(L); seenG.add(L); ok = true;
            const ext = (L.w / 2) * Math.abs(Math.sin(a)) + (L.h / 2) * Math.abs(Math.cos(a));
            knocks.push({ fam: f.id, gen: g.gen, angle: ((a % TAU) + TAU) % TAU, half: (ext + 6) / (g.r * k) });
          }
        }
      }
      for (const L of genPool.values()) if (!seenG.has(L)) hideL(L);
      const sig = knocks.map((q) => `${q.fam}:${q.gen}:${q.angle.toFixed(3)}:${q.half.toFixed(3)}`).join("|");
      if (sig !== knockSig) { knockSig = sig; S.links.genArcs.setKnockouts(knocks); S.links.genArcs.setTagged?.(knocks.length ? knocks[0].fam : -1, knocks.map((q) => q.gen)); }
    }

    // ---- 3. children: budget 40 (1.3-4 k0) / 64 (> 4 k0) / 16 phone; priority mcap x (1 + 1.5 live) ----
    const shownKids = new Set(), insideKids = [];
    if (kidsOK || hov >= 0) {
      const live = (i) => S.age[i] <= 1800;
      const pri = (i) => mc[i] * (1 + 1.5 * live(i));
      if (hov >= 0) { const f = fams[famOf[hov]]; if (!(f.planet && hov === f.top) && (f.planet || showDust) && R[hov] * k >= 1 && !cand.includes(hov)) cand.push(hov); }
      cand.sort((a, b) => (b === hov) - (a === hov) || pri(b) - pri(a) || n24[b] - n24[a]);
      const budget = ph ? 16 : kB > 4 ? 64 : 40, two = kB > 4;   // (look fix) keyed to the frame fit (kB), see above
      const top = cand.slice(0, Math.min(cand.length, budget * 6));
      const spec = top.map((i) => {
        const L = kidL(i), r = drawnR(i, fams[famOf[i]]), ar = r + (r >= TOK.arcMinR && n24[i] > 0 ? TOK.arcGap + 1.5 : 0), t2 = two && r >= 14;
        const [sx, sy] = toS(X[i], Y[i]);
        const w = t2 ? L.w2 : L.w1, h = t2 ? 26 : 14;
        reserveL(L, sx, sy, ar, 4, w, h);
        return { L, i, sx, sy, ar, t2, w, h };
      });
      let n = 0;
      // (final polish) one label per ticker in view: copycat families repeat names ($SIB x5, $kimchi/$Kimchi/$KIMCHI), and
      // five identical labels read as a rendering bug. The biggest / hottest of each name wins (candidates are in priority order).
      const seenSym = new Set();
      // (round 2 final) a seed head (brood > 60) is named sparsely: at most SEED_LAB labels per head and one per 36 deg
      // sector around its parent (biggest / hottest first, as the candidates are ordered), so the rim never becomes a
      // callout forest on one side
      const SEED_LAB = 10, seedN = new Map(), seedSec = new Map();
      const seedOK = (i) => {
        const p = S.par[i]; if (p < 0 || S.kids[p].length <= 60 || i === hov) return true;
        const n = seedN.get(p) || 0; if (n >= SEED_LAB) return false;
        const a = Math.atan2(Y[i] - Y[p], X[i] - X[p]), sec = ((Math.floor((a + Math.PI) / (TAU / 10)) % 10) + 10) % 10, m = seedSec.get(p) || 0;
        if (m & (1 << sec)) return false;
        return true;
      };
      const seedTake = (i) => { const p = S.par[i]; if (p < 0 || S.kids[p].length <= 60) return; seedN.set(p, (seedN.get(p) || 0) + 1); const a = Math.atan2(Y[i] - Y[p], X[i] - X[p]), sec = ((Math.floor((a + Math.PI) / (TAU / 10)) % 10) + 10) % 10; seedSec.set(p, (seedSec.get(p) || 0) | (1 << sec)); };
      const focFam = U.uFocusFam.value >= 0 && U.uFocusMix.value > 0.5 ? U.uFocusFam.value : -1;
      for (const L of planetLab) if (L.on && L.lay === layN) seenSym.add(tickerBody(sym[L.f.top]).toLowerCase());
      for (const s of spec) {
        if (n >= budget && s.i !== hov) break;
        if (pinOn && s.i === pinI) continue;   // (focus lane) pinned above
        const L = s.L;
        if (s.sx < -20 || s.sy < -20 || s.sx > Wd + 20 || s.sy > Hd + 20) continue;
        if (unlabelable(sym[s.i]) && s.i !== hov) continue;   // (round 2 final) ticker hygiene
        if (!seedOK(s.i)) continue;
        const key = tickerBody(sym[s.i]).toLowerCase();
        if (seenSym.has(key) && s.i !== hov) continue;
        // (final polish) when a family owns the view, only its children (and the hovered coin) are named
        if (focFam >= 0 && famOf[s.i] !== focFam && s.i !== hov && !(hov >= 0 && famOf[s.i] === famOf[hov])) continue;
        setCls(L, "livec", live(s.i) ? "lv" : "");   // (map3 port) 'lv': the app has a global .live
        // a disc big enough for its own name carries it inside (bubble-chart convention): the biggest children are named
        // first, where there is never room around them; the bubble hides its core / monogram under the text
        const r = R[s.i] * k, logo = S.bubbles.hasLogo && S.bubbles.hasLogo(s.i);
        if (!logo && r >= 15 && L.w1 - HALO[11] <= 1.7 * r - 6) {
          const two = r >= 24 && L.w2 - HALO[10] <= 1.5 * r - 6, h = two ? 26 : 14, w = (two ? L.w2 : L.w1) - HALO[11];
          const b = { x0: s.sx - w / 2, y0: s.sy - h / 2, x1: s.sx + w / 2, y1: s.sy + h / 2 };
          if (b.x0 > 2 && b.y0 > 2 && b.x1 < Wd - 2 && b.y1 < Hd - 2 && !hardHit(b, s.i)) {
            setCls(L, "stc", two ? "st" : ""); setCls(L, "inc", "in"); L.w = w; L.h = h;
            commit(L, { d: "C", disp: 0 }, b, null); L.want = 0;
            n++; shownKids.add(s.i); insideKids.push(s.i); seenSym.add(key); seedTake(s.i); setO(L, 1); applyDim(L);
            continue;
          }
        }
        setCls(L, "inc", ""); setCls(L, "stc", s.t2 ? "st" : "");
        if (L.slot && L.slot.d === "C") L.slot = null;
        L.w = s.w; L.h = s.h;
        if (tryPlace(L, s.sx, s.sy, s.ar, DIRS_KID, 4, s.w, s.h, s.i !== hov)) { n++; shownKids.add(s.i); seenSym.add(key); seedTake(s.i); setO(L, 1); applyDim(L); }
      }
    }
    S.bubbles.setInside?.(insideKids);
    for (const [i, L] of kidPool) if (!shownKids.has(i)) hideL(L);
    lastShownKids = shownKids;
    trimKids();

    // ---- 4. dust caption: 14 px under its anchor, above the legend/stats ----
    // (repair, look fix 2026-10-22) on the phone too, now that its overview keeps every family in frame (scene.js): the
    // caption says what the specks are; it still loses every collision with the HUD and the planet labels
    {
      const L = capL; let ok = false;
      const capO = S.dustA * (1 - smooth(1.3 * k0, 1.6 * k0, k));   // a quiet overview caption: gone once zoomed in
      capDbg.gate = { ph, G, capO: +capO.toFixed(3), dustA: S.dustA, cap: !!S.dustCaption, k: +k.toFixed(3), k0: +k0.toFixed(3) };
      if ((!ph || !G) && capO > 0.05 && S.dustCaption) {   // galaxy keeps its desktop-only caption
        const [ax, ay] = toS(S.dustCaption.x, S.dustCaption.y);
        // the lowest y the caption may reach: 16 px above the frame's foot, or 8 px above a HUD box BELOW yRef that shares its
        // x range (the phone's top chrome - search, chips - is a HUD box too and must not pin the caption off-screen)
        const limAt = (x0, yRef) => { let lim = Hd - 16; for (const r of hudRaw) if (r.x0 < x0 + L.w && r.x1 > x0 && r.y1 > yRef) lim = Math.min(lim, r.y0 - 8); return lim; };
        const tryAt = (x0, y0) => {
          const b = { x0, y0, x1: x0 + L.w, y1: y0 + L.h };
          if (!(b.x0 > 2 && b.x1 < Wd - 2 && b.y0 > 2) || hardHit(b, -1)) return false;
          gAdd(grid, items, { ...b, kind: "lab", own: -1 }); placedBoxes.push({ ...b, L }); showL(L, x0, y0); setO(L, capO); applyDim(L); return true;
        };
        const x0 = ax - L.w / 2;
        ok = tryAt(x0, Math.min(ay + 14, limAt(x0, ay) - L.h));
        // (repair) the anchor (just under the planet cluster) is taken by a planet label on a phone: the caption then sits
        // at the foot of the frame, above the HUD, centred on the fit rect (over the specks it describes)
        let xb = 0, yb = 0;
        if (!ok && ph) { const fr = S.fitRect ? S.fitRect() : { x0: 0, x1: Wd }; xb = (fr.x0 + fr.x1) / 2 - L.w / 2; yb = limAt(xb, Hd / 2) - L.h; ok = tryAt(xb, yb); }
        capDbg.place = { ok, w: L.w, h: L.h, ax: +ax.toFixed(1), ay: +ay.toFixed(1), x0: +x0.toFixed(1), lim: +limAt(x0, ay).toFixed(1), xb: +xb.toFixed(1), yb: +yb.toFixed(1), Wd, Hd, hud: hudRaw.length, capO: +capO.toFixed(2) };
      }
      if (!ok) hideL(L);
    }

    // ---- 5. editorial annotations: <= 2, desktop >= 1024, overview only; they lose every collision ----
    {
      // (round 2 final) callouts are an overview caption: hidden while a coin is held and while the region glides home
      // (they re-anchored mid-drag and pointed at the wrong family), then they come back in place
      const dr = S.drag, moving = !!(dr && (dr.active || dr.settling));
      const o = moving ? 0 : 1 - smooth(1.3 * k0, 1.6 * k0, k);
      const big = planets[0];
      const list = [];
      if (!ph && Wd >= 1024 && o > 0.02 && big) {
        // (final polish) line 2 never repeats the planet label ('37% · 1,481 coins'): it adds the family's market cap / trades
        const famMc = (f) => { let v = 0; for (const i of f.members) v += mc[i] || 0; return v; };
        if (active && active.f === big) list.push({ f: big, l1: "Largest family · most active", l2: `${esc(fmtUsd(famMc(big)))} market cap${SEP}${fmtCount(active.n)} trades in 1h` });
        else {
          list.push({ f: big, l1: "Largest family", l2: `${esc(fmtUsd(famMc(big)))} combined market cap` });
          if (active) list.push({ f: active.f, l1: "Most active in the last hour", l2: `${fmtN(active.n)} trades` });
        }
      }
      const [ccx] = toS(0, 0), clR = (S.Rcl || 0) * k;
      const usedY = [];
      annL.forEach((L, n) => {
        const a = list[n]; L.elbow = null;
        if (!a) { hideL(L); return; }
        L.fam = a.f.id;
        setAnn(L, a.l1, a.l2);
        const j = planets.indexOf(a.f); const sx = chipX[j], sy = chipY[j], cr = chipR[j];
        let ok = false;
        const sides = sx >= ccx ? [1, -1] : [-1, 1];
        // pass 1 wants a free lane (the leader crosses no chip or label), pass 2 accepts crossings
        for (let pass = 0; pass < 2 && !ok; pass++) for (const side of sides) {
          const edge = ccx + side * (clR + 24);
          const x0 = side > 0 ? edge : edge - L.w;
          if (x0 < 8 || x0 + L.w > Wd - 8) continue;
          for (const dy of [0, -24, 24, -48, 48, -72, 72, -96, 96, -120, 120, -144, 144]) {
            const cy = sy + dy, b = { x0, y0: cy - L.h / 2, x1: x0 + L.w, y1: cy + L.h / 2 };
            if (b.y0 < 8 || b.y1 > Hd - 8 || usedY.some((u) => Math.abs(u - cy) < 34) || hardHit(b, -1) || boxInColony(b, a.f.id)) continue;
            // elbow: leave the rim on the 45 deg diagonal toward the text (clears the chip's own E/W label),
            // run diagonally to the text's first line, then horizontally into the margin
            // (round 2 final) the leader ends on the family's VISIBLE edge (90th-percentile member distance), not on the
            // hull radius, which a few far satellites inflate: it ended ~170 px short of the $PUMP chip
            const ex = side > 0 ? x0 - 4 : x0 + L.w + 4, ty = cy - L.h / 2 + 7, rr = Math.max(cr, visR(a.f) * k) + 3, dyT = ty - sy;
            let el;
            if (Math.abs(dyT) <= rr * D45) { const px = sx + side * Math.sqrt(rr * rr - dyT * dyT); if ((ex - px) * side < 8) continue; el = [px, ty, ex, ty]; }
            else { const px = sx + side * rr * D45, py = sy + Math.sign(dyT) * rr * D45, mx = px + side * Math.abs(ty - py); if ((ex - mx) * side < 8) continue; el = [px, py, mx, ty, ex, ty]; }
            if (pass === 0 && pathHit(el, a.f.top)) continue;
            if (pathInColony(el, a.f.id)) continue;   // (final fix) both passes: hide the callout rather than cross a colony
            L.elbow = el;
            gAdd(grid, items, { ...b, kind: "lab", own: -1 }); placedBoxes.push({ ...b, L });
            setCls(L, "alc", side > 0 ? "al-l" : "al-r"); showL(L, b.x0, b.y0); setO(L, o); applyDim(L);
            usedY.push(cy); ok = true; break;
          }
          if (ok) break;
        }
        if (!ok) hideL(L);
      });
    }

    // ---- 6. (round 2 final) event labels: 'new · $TICKER' for a birth (4 s), '$TICKER +$12k' for a whale trade (2 s).
    // Placed last, in the first free side (right, left, above, below) of their coin; they never push other labels.
    for (let q = toasts.length - 1; q >= 0; q--) {
      const T = toasts[q], now = performance.now(), L = T.L;
      if (now >= T.until) { hideL(L); const e = L.e; life.timeout(() => e.remove(), 400); toasts.splice(q, 1); continue; }
      const at = T.at || (T.i >= 0 && T.i < X.length ? { x: X[T.i], y: Y[T.i] } : null); if (!at) { hideL(L); continue; }
      const [sx, sy] = toS(at.x, at.y), r = Math.max(2, T.i >= 0 && S.bubbles.screenR ? S.bubbles.screenR(T.i) : (T.at.r || 0.5) * k) + 5;
      let ok = false;
      for (const [x0, y0] of [[sx + r, sy - L.h / 2], [sx - r - L.w, sy - L.h / 2], [sx - L.w / 2, sy - r - L.h], [sx - L.w / 2, sy + r]]) {
        const b = { x0, y0, x1: x0 + L.w, y1: y0 + L.h };
        if (b.x0 < 4 || b.y0 < 4 || b.x1 > Wd - 4 || b.y1 > Hd - 4 || hardHit(b, -1)) continue;
        gAdd(grid, items, { ...b, kind: "lab", own: -1 }); placedBoxes.push({ ...b, L }); showL(L, b.x0, b.y0); setO(L, 1); ok = true; break;
      }
      if (!ok) hideL(L);
    }
    for (const L of planetLab) if (L.lay !== layN) hideL(L);
    lastChips = chips;
    drawLeaders();
    pushSwarmMask();
  }
  // (family-all, fix round) the swarm keeps its specks out of the labels placed over a ghosted family (planet title and its
  // '6.3% · 79.9k coins' line, children, generation tags, the pinned name): their text halo covers the glyphs only, the grey
  // dots showed between the words. World rects, most important first, at most 24 (swarm.js LAB_MAX).
  const swMask = new Float32Array(4 * 24);
  function pushSwarmMask() {
    const sw = S.swarm; if (!sw || !sw.on || typeof sw.setMask !== "function") return;
    let n = 0;
    const ghosted = (fid) => fid >= 0 && !!fams[fid] && fams[fid].ghost > 0;
    const addBox = (b) => {
      if (!b || n >= 24) return;
      const [ax, ay] = toW(b.x0, b.y0), [bx, by] = toW(b.x1, b.y1);
      swMask[4 * n] = ax; swMask[4 * n + 1] = ay; swMask[4 * n + 2] = bx; swMask[4 * n + 3] = by; n++;
    };
    for (const L of planetLab) if (L.on && L.lay === layN && L.box && ghosted(L.fam)) addBox(L.box);
    if (pinL.on && pinL.box) addBox(pinL.box);
    for (const L of genPool.values()) if (L.on && L.lay === layN && L.box && ghosted(L.fam)) addBox(L.box);
    for (const L of kidPool.values()) if (L.on && L.lay === layN && L.box && ghosted(L.fam)) addBox(L.box);
    sw.setMask(swMask, n);
  }

  // ---------- tooltip ----------
  const tip = S.layers.tip;
  let tipI = -1, tipImgOff = null, tipText = "";
  const CLS_CHIP = ["c0", "c1", "c2", "c3"];
  const imgReady = (u) => { try { return !!(u && S.images && typeof S.images.ready === "function" && S.images.ready(u)); } catch { return false; } };
  // (final polish) the chip is the coin's OWN last trade (as its rim); the family's activity has its own rows. Lineage names
  // the parent. A footer says what a click does. (map3 port) the 'Family' row carries the app's dominance tag.
  function tipHTML(i) {
    const f = fams[famOf[i]], isTop = i === f.top;
    const a = S.age[i], c = heatClass(a);
    const im = img[i] && imgReady(img[i]) ? `<img src="${esc(img[i])}" alt="" decoding="async">` : "";
    const mono = esc((tickerBody(sym[i])[0] || "?").toUpperCase());
    const p = S.par[i];
    const hr = S.heatIdx?.get(mint?.[i]), vol = hr !== undefined && S.heat?.v24 ? +S.heat.v24[hr] || 0 : 0;
    const g = gen[i] === 0 ? "root" : `gen ${gen[i]} · child of ${tickerHTML(sym[p])}`;
    const focused = S.motion.focusedFam?.() === f.id;
    const foot = phone() ? `<div class="tp-act"><button type="button" class="tp-open">${focused ? "Select" : "Open family"}</button><button type="button" class="tp-x" aria-label="Close">×</button></div>`
      : `<div class="tp-foot">${focused ? "click to select" : "click to open the family"}</div>`;
    // (round 2 final) a family top whose family traded more recently than the top itself leads with the family's recency
    const famLead = isTop && f.members.length > 1 && f.age < a;
    const chip = famLead ? `<span class="tp-chip ${CLS_CHIP[heatClass(f.age)]}">family · ${agoChip(f.age)}</span>` : `<span class="tp-chip ${CLS_CHIP[c]}">${agoChip(a)}</span>`;
    let tag = null; try { tag = tagText(S.tagOf(mint[f.top])); } catch { tag = null; }
    // (final fix) one line, as the prototype: 'N coins · 37%'. The size toggle, the Key and the side panel say which value
    // the share is of; the mode word wrapped the row onto two lines and made the card taller than the prototype's.
    const famRow = `${fmtN(sizeOf(f))} ${sizeOf(f) === 1 ? "coin" : "coins"}${tag ? `${SEP}${esc(tag)}` : ""}`;
    return `<div class="tp-h"><span class="tp-logo">${mono}${im}</span><span class="tp-sym">${tickerHTML(sym[i])}</span>${chip}</div>` +
      `<div class="tp-rows"><span class="tp-k">Market cap</span><span class="tp-v">${esc(fmtUsd(mc[i]))}</span>` +
      `<span class="tp-k">24h trades</span><span class="tp-v">${fmtN(n24[i] || 0)}</span>` +
      (vol > 0 ? `<span class="tp-k">24h volume</span><span class="tp-v">${esc(fmtUsd(vol))}</span>` : "") +
      (isTop && f.members.length > 1 ? `<span class="tp-k">Family 24h</span><span class="tp-v">${fmtN(f.n24 || 0)} trades</span><span class="tp-k">Family last trade</span><span class="tp-v">${agoChip(f.age)}</span>` : "") +
      `<span class="tp-k">Lineage</span><span class="tp-v">${g}</span>` +
      `<span class="tp-k">Family</span><span class="tp-v">${famRow}</span>` +
      `<span class="tp-k">Mint</span><span class="tp-v mint">${esc(shortMint(mint?.[i]))}</span></div>` + foot;
  }
  // (family-all) a speck of a capped asset family: ticker, market cap, age, its family's true size; the last trade is the
  // header chip ('3m ago' / 'no trades 24h'; fix round: a 'Last trade' row repeated it)
  const ageTxt = (a) => (a < 3600 ? `${Math.max(1, Math.round(a / 60))}m` : a < 172800 ? `${Math.round(a / 3600)}h` : `${Math.round(a / 86400)}d`);
  function dustTipHTML(i) {
    const d = S.swarm && S.swarm.tip(i); if (!d) return "";
    const f = d.fam, s = d.symbol || String(d.mint).slice(0, 4), c = heatClass(d.age);
    const mono = esc((tickerBody(s)[0] || "?").toUpperCase());
    const ageS = d.createdAt > 0 ? Math.max(0, Date.now() / 1000 - d.createdAt) : -1;
    const focused = f && S.motion.focusedFam?.() === f.id;
    const foot = phone() ? `<div class="tp-act"><button type="button" class="tp-open">Select</button><button type="button" class="tp-x" aria-label="Close">×</button></div>`
      : `<div class="tp-foot">${focused ? "click to select" : "click to select the coin"}</div>`;
    return `<div class="tp-h"><span class="tp-logo">${mono}</span><span class="tp-sym">${tickerHTML(s)}</span><span class="tp-chip ${CLS_CHIP[c]}">${agoChip(d.age)}</span></div>` +
      `<div class="tp-rows"><span class="tp-k">Market cap</span><span class="tp-v">${esc(fmtUsd(d.mcapUsd))}</span>` +
      (ageS >= 0 ? `<span class="tp-k">Age</span><span class="tp-v">${esc(ageTxt(ageS))}</span>` : "") +
      (f ? `<span class="tp-k">Family</span><span class="tp-v">${tickerHTML(sym[f.top])}${SEP}${fmtN(sizeOf(f))} coins</span>` : "") +
      `<span class="tp-k">Mint</span><span class="tp-v mint">${esc(shortMint(d.mint))}</span></div>` + foot;
  }
  const fillTip = (i) => {
    if (tipImgOff) { tipImgOff(); tipImgOff = null; }
    if (i >= DUST0) { tip.innerHTML = dustTipHTML(i); tipText = tip.textContent || ""; return; }
    tip.innerHTML = tipHTML(i);
    tipText = tip.textContent || "";
    const im = tip.querySelector(".tp-logo img");
    if (im) tipImgOff = life.on(im, "error", () => { im.remove(); if (tipImgOff) { tipImgOff(); tipImgOff = null; } });
  };
  // phone: the docked card's actions (the card takes pointer events; the canvas never sees these taps). (map3 port) 'Open
  // family' / 'Select' act like a second tap on the coin (motion's click rule), '×' clears the hover.
  // (final fix) a click within GHOST_MS of the card appearing is the tap that opened it (a browser that still sends the
  // compatibility click after touchend), never a press on the card
  let tipShownAt = 0;
  const GHOST_MS = 400;
  if (tip) life.on(tip, "click", (e) => {
    const i = tipI; if (i < 0) return;
    if (performance.now() - tipShownAt < GHOST_MS) return;
    const t = e.target;
    if (t && t.closest && t.closest(".tp-x")) { S.motion.clearHover?.(true); hideTip(); }
    else if (t && t.closest && t.closest(".tp-open")) { hideTip(); S.motion.tapAction?.(i); }
  });
  const showTip = (i, sx, sy) => {
    if (!tip || i < 0 || (i >= N && !(i >= DUST0 && S.swarm && S.swarm.mintAt(i))) || S.dead) return;
    // (map3 port) never for the selected coin: the app's panel shows it
    if (S.motion.selected && S.motion.selected() === i) { hideTip(); return; }
    const ph = phone();
    if (!tip.classList.contains("on") || i !== tipI) tipShownAt = performance.now();
    if (i !== tipI || tip.dataset.f !== String(S.motion.focusedFam?.())) { tipI = i; tip.dataset.f = String(S.motion.focusedFam?.()); fillTip(i); }
    tip.classList.toggle("dock", ph);
    if (ph) {
      tip.style.transform = "";
      // (final fix) the docked card spans the bottom of the screen: a coin it would cover glides up above it
      tip.classList.add("on");
      const top = tip.offsetTop;
      if (top > 0) S.motion.keepAbove?.(i, top - 12);
    }
    else {
      const w = tip.offsetWidth, h = tip.offsetHeight, Wd = W(), Hd = H();
      // (integration) the card never covers the hovered coin's own label (ticker + stats) or its chip: try SE, SW, NE,
      // NW of the pointer, then below / above that label; the first spot clear of both (and of the container edge) wins
      const own = [];
      if (i >= DUST0) {   // (family-all) a speck: its pinned name and the speck itself
        if (pinL.on && pinL.box && pinL.i === i) own.push(pinL.box);
        const p = S.swarm.pos(i);
        if (p) { const [cx, cy] = toS(p[0], p[1]), r = Math.max(4, S.swarm.screenR(i)) + 4; own.push({ x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r }); }
      } else { const f = fams[famOf[i]], j = f.planet && i === f.top ? planets.indexOf(f) : -1, L = j >= 0 ? planetLab[j] : kidPool.get(i);
        if (L && L.on && L.box) own.push(L.box);
        const [cx, cy] = toS(X[i], Y[i]), r = Math.max(S.bubbles.outerR ? S.bubbles.outerR(i) : R[i] * S.cam.k, 4) + 4;
        own.push({ x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r }); }
      const ub = own.reduce((u, b) => ({ x0: Math.min(u.x0, b.x0), y0: Math.min(u.y0, b.y0), x1: Math.max(u.x1, b.x1), y1: Math.max(u.y1, b.y1) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
      const cands = [[sx + 16, sy + 16], [sx - 16 - w, sy + 16], [sx + 16, sy - 16 - h], [sx - 16 - w, sy - 16 - h], [Math.min(sx, ub.x0), ub.y1 + 8], [Math.min(sx, ub.x0), ub.y0 - 8 - h]];
      const fits = ([x, y]) => x >= 8 && y >= 8 && x + w <= Wd - 8 && y + h <= Hd - 8;
      const clear = ([x, y]) => own.every((b) => x > b.x1 || x + w < b.x0 || y > b.y1 || y + h < b.y0);
      let [x, y] = cands.find((c) => fits(c) && clear(c)) || cands.find(fits) || cands[0];
      if (x + w > Wd - 8) x = sx - 16 - w; if (y + h > Hd - 8) y = sy - 16 - h;
      x = Math.max(8, x); y = Math.max(8, y);
      tip.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
    }
    tip.classList.add("on");
    dockFlag();
  };
  const hideTip = () => { if (!tip) return; tip.classList.remove("on"); tipI = -1; dockFlag(); };
  // (local perf 2026-11-09) the docked phone tip hides the zoom controls through a class on the map root. The CSS used to be
  // .m3:has(.m3-tip.dock.on): every label toggling its own .on class (all through a zoom) re-ran that :has() over the map's
  // subtree, ~2x the style work per frame of a flight.
  function dockFlag() { const root = tip && tip.closest(".m3"); if (root) root.classList.toggle("m3-tip-docked", tip.classList.contains("dock") && tip.classList.contains("on")); }
  const tipInfo = () => ({ on: !!tip && tip.classList.contains("on"), i: tipI, dock: !!tip && tip.classList.contains("dock"), text: tip && tip.classList.contains("on") ? tipText : "" });
  // (map3 port) the phone dock sits above the page's bottom inset (the peek sheet / pills)
  const setDock = () => { if (tip) tip.style.setProperty("--m3-dock-bottom", `${Math.max(0, Number(S.inset.bottom) || 0) + 8}px`); };
  setDock();

  S.on("resize", () => { readHud(); lW = 0; if (readyDone) layoutLabels(); });
  // (focus lane) a committed drag (the rope came to rest, motion.js): the dropped coins are the new home. The visible-radius
  // cache (measured from the old shape) is dropped and the labels re-slot around the new positions at once.
  S.on("positions", (p) => { if (p && p.committed) { visRc.clear(); dragMem = null; if (readyDone) layoutLabels(); } });

  // ---------- tags, highlight, numbers (map3 port) ----------
  const setTags = (fn) => {
    if (typeof fn === "function") S.tagOf = fn;
    for (const L of planetLab) { L.fill(); L.measure(); }
    for (const L of annL) L.sig = "";
    if (tip && tipI >= 0) fillTip(tipI);
    if (readyDone) layoutLabels();
  };
  const setHl = () => { for (const L of allLabels()) applyDim(L); fadeKick(); };
  // a patched market cap: the pooled child label's second line follows (radius and layout wait for a rebuild)
  const patched = (i) => {
    const L = kidPool.get(i);
    if (L) { const s = L.e.querySelector(".s"); if (s) s.textContent = fmtUsd(mc[i]); L.measure(); }
    if (tip && tipI === i) fillTip(i);
  };
  const setInsets = () => { readHud(); setDock(); if (readyDone) layoutLabels(); };

  // ---------- ready ----------
  const ready = () => {
    readyDone = true;
    stats.counts = stats.counts || countsNow();
    renderStats();
    readHud();
    layoutLabels();
  };
  const titles = () => planetLab.filter((L) => L.on && L.lay === layN).map((L) => L.f.top);
  const taggedTitles = () => planetLab.filter((L) => L.on && L.lay === layN && L.tag && L.stc === "st").map((L) => L.f.top);
  const labelCount = () => placedBoxes.filter((p) => p.L.on).length;

  Object.assign(S.labels, { layoutLabels, readHud, showTip, hideTip, ready, updateStats, toast, setTags, setHl, patched, setInsets,
    titles, taggedTitles, labelCount, drawnCount: () => drawnN, tipInfo, setFps: () => {},
    pinned: () => ({ i: pinL.i, on: pinL.on, box: pinL.on && pinL.box ? { ...pinL.box } : null }) });
  S.debug.map.labelsMs = Math.round(performance.now() - tL0);

  // ---------- debug ----------
  S.debugFns.labels = () => {
    const vis = placedBoxes.filter((p) => p.L.on);
    const ov = (A, B) => A.x0 < B.x1 - 0.5 && A.x1 > B.x0 + 0.5 && A.y0 < B.y1 - 0.5 && A.y1 > B.y0 + 0.5;
    let ll = 0, lc = 0, lh = 0;
    for (let a = 0; a < vis.length; a++) for (let b = a + 1; b < vis.length; b++) if (ov(vis[a], vis[b])) ll++;
    for (const p of vis) {
      for (const c of lastChips) { const dx = Math.max(p.x0 - c.cx, 0, c.cx - p.x1), dy = Math.max(p.y0 - c.cy, 0, c.cy - p.y1); if (dx * dx + dy * dy < (c.r - 0.5) ** 2) lc++; }
      for (const h of hudRaw) if (ov(p, h)) lh++;
    }
    const count = (kind) => vis.filter((p) => p.L.kind === kind).length;
    return {
      planetsLabelled: count("pl"), kids: count("kid"), gens: count("gen"), caption: count("cap"), annotations: count("ann"), toasts: count("evt"),
      leaders: vis.filter((p) => p.L.leader || p.L.elbow).length,
      overlaps: ll + lc + lh, labelLabel: ll, labelChip: lc, labelHud: lh,
      // (final fix) planet labels / callouts on, and leaders / elbows across, another family's colony (QA gate: 0)
      foreignColony: vis.filter((p) => (p.L.kind === "pl" || p.L.kind === "ann") && (boxInColony(p, p.L.fam) || ((p.L.leader || p.L.elbow) && pathInColony(p.L.elbow || p.L.leader, p.L.fam)))).length,
      colonies: colonies.length,
      draws: S.gfx.drawStats?.scene ?? 0, frameDraws: S.gfx.drawStats?.frame ?? 0, tris: S.gfx.drawStats?.tris ?? 0,
    };
  };

  // ---------- teardown (map3 port): pooled elements, the leaders canvas, the tooltip ----------
  life.onDispose(() => {
    if (tipImgOff) { tipImgOff(); tipImgOff = null; }
    for (const L of allLabels()) { try { L.e.remove(); } catch { /* ignore */ } }
    try { pinL.e.remove(); } catch { /* ignore */ }
    kidPool.clear(); genPool.clear(); toasts.length = 0; placedBoxes.length = 0; items.length = 0; soft.length = 0; small.length = 0;
    grid.clear(); softGrid.clear(); smallGrid.clear();
    if (lctx) { try { lctx.setTransform(1, 0, 0, 1, 0, 0); lctx.clearRect(0, 0, lcv.width, lcv.height); } catch { /* ignore */ } lcv.width = lcv.height = 0; }
    // the docked-card flag lives on the .m3 root, which outlives this engine (size-mode / roots / data rebuilds): clear it
    // unless a newer engine's card is already docked there
    if (tip) {
      tip.classList.remove("on");
      const root = tip.closest(".m3");
      if (root && !root.querySelector(".m3-tip.dock.on")) root.classList.remove("m3-tip-docked");
      tip.innerHTML = "";
    }
    readyDone = false;
  });
}
