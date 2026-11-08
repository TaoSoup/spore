// The front page's colony (DESIGN-ELEVATE §7), the React shell. It loads the biggest tree on Spore (the
// same calls the old live tree made: the top root by locked value, then its tree two levels deep),
// refreshes it every 5 minutes while on screen, buds a child when a coin launches under it and sends a
// mote up a filament when one of its coins trades. The drawing is the SVG fallback until the 3D chunk
// (./colony, three.js) has loaded after the first paint; it stays the SVG without WebGL2, under reduced
// or paused motion, and after a GPU failure. The stage reserves its box, so nothing shifts on load.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type Coin, type TreeNode } from "../../lib/api";
import { useEvents } from "../../lib/events";
import { plural, usdCard } from "../../lib/format";
import { coarsePointer, useMotionPref, usePointer } from "../../lib/motion";
import { nameOf, sym } from "../Bits";
import { LiveDot } from "../SpawnFeed";
import Term from "../Term";
import { webgl2Available } from "../map3/probe";
import ColonyFallback from "./ColonyFallback";
import type { Colony, ColonyData, ColonyHover } from "./colony";
import "./hero.css";

const MAX_KIDS = 12, GRAND_PER = 3, RETRY_MS = 30_000, REFRESH_MS = 5 * 60_000, TAGS = 4;
/** How long the drawing stays mounted under the first 3D frame: the canvas's fade-in (--dur-5) plus a margin. */
const SETTLE_MS = 1200;

type Kid = { mint: string; name: string; symbol: string | null; image: string | null; createdAt: number; locked: number; mcap: number; grand: string[] };
type Tree = { root: Coin; kids: Kid[]; count: number };
type Phase = "loading" | "ready" | "empty" | "error";

const newest = (a: { createdAt: number }, b: { createdAt: number }) => b.createdAt - a.createdAt;
const kidOf = (c: Coin, kids: TreeNode[] = []): Kid => ({
  mint: c.mint, name: nameOf(c), symbol: c.symbol, image: c.image, createdAt: c.createdAt ?? 0, locked: c.lockedUsd ?? 0, mcap: c.mcapUsd ?? 0,
  grand: kids.map((n) => n.coin).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, GRAND_PER).map((c) => c.mint),
});
/// "$SYM" trimmed to 10 characters; a ticker that already starts with "$" keeps one.
const tickerOf = (s: string | null, mint: string) => { const t = (s ?? "").replace(/^\$+/, ""); return t ? "$" + (t.length > 10 ? `${t.slice(0, 9)}…` : t) : sym({ symbol: null, mint }); };

function toData(t: Tree): ColonyData {
  const kids = t.kids.slice(0, MAX_KIDS);
  const byLocked = kids.some((k) => k.locked > 0);
  return {
    root: { mint: t.root.mint, label: tickerOf(t.root.symbol, t.root.mint), image: t.root.image },
    kids: kids.map((k) => ({ mint: k.mint, label: tickerOf(k.symbol, k.mint), weight: byLocked ? k.locked : k.mcap, grand: k.grand, image: k.image })),
  };
}

/** The colony's data: phase, the tree, and a reload. Refreshes only while `active`. */
function useBiggestTree(active: boolean) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [tree, setTree] = useState<Tree | null>(null);
  const loadedAt = useRef(0);
  const load = useCallback(async () => {
    try {
      const top = (await api.roots("locked", 1)).roots[0];
      if (!top) { setPhase("empty"); setTree(null); loadedAt.current = Date.now(); return; }
      const t = await api.tree(top.mint, 2);
      const root = t.coin ?? top;
      setTree({ root, kids: t.children.map((n) => kidOf(n.coin, n.children)).sort(newest), count: Math.max(root.children ?? 0, t.children.length) });
      setPhase("ready");
      loadedAt.current = Date.now();
    } catch {
      // A failed refresh keeps the tree; only a first load shows the error state.
      setPhase((p) => (p === "ready" ? p : "error"));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      if (phase === "error") void load();
      else if (phase !== "loading" && Date.now() - loadedAt.current > REFRESH_MS) void load();
    }, RETRY_MS);
    return () => clearInterval(t);
  }, [active, phase, load]);
  return { phase, tree, setTree };
}

export default function SporeColony({ className = "" }: { className?: string }) {
  const stage = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const tagRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const colony = useRef<Colony | null>(null);
  const [onScreen, setOnScreen] = useState(true);
  const [faded, setFaded] = useState(false); // scrolled 1.2 screens down: invisible, so the loop rests
  const [paused] = useMotionPref();
  const [failed, setFailed] = useState(false);
  const [gl, setGl] = useState(false); // the scene has drawn its first frame
  const [settled, setSettled] = useState(false); // the canvas has faded in: the drawing under it unmounts
  const [hover, setHover] = useState<ColonyHover>(null);
  const pointer = usePointer();
  const pointerRef = useRef(pointer);
  pointerRef.current = pointer;
  const navigate = useNavigate();
  const { phase, tree, setTree } = useBiggestTree(onScreen);
  const data = useMemo(() => (tree ? toData(tree) : null), [tree]);
  const dataRef = useRef(data);
  dataRef.current = data;
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const want3d = !paused && !failed && phase !== "empty";

  // On screen and in a visible tab, or nothing runs.
  useEffect(() => {
    const el = stage.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setOnScreen(e.isIntersecting), { rootMargin: "80px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // The 3D chunk: after the first paint, only when it can run well.
  useEffect(() => {
    if (!want3d) return;
    const canvas = canvasRef.current, el = stage.current;
    if (!canvas || !el || !webgl2Available()) return;
    let alive = true, c: Colony | null = null;
    const lite = coarsePointer() || window.innerWidth < 760;
    const boot = () => {
      import("./colony").then(({ createColony }) => {
        if (!alive) return;
        try {
          c = createColony(canvas, {
            lite,
            onLost: () => { if (alive) { setFailed(true); setGl(false); } },
            onHover: (h) => { if (alive) setHover(h); },
            label: tipRef.current,
            tags: tagRefs.current.filter((x): x is HTMLSpanElement => x !== null),
            pointer: coarsePointer() ? null : pointerRef.current,
          });
        } catch {
          setFailed(true);
          return;
        }
        colony.current = c;
        // development builds only: a handle for the QA probes (trade motes, buds); compiled out in production
        if (import.meta.env.DEV) (window as unknown as { __sporeColony?: Colony }).__sporeColony = c;
        const r = el.getBoundingClientRect();
        c.resize(r.width, r.height, window.innerWidth >= 1024);
        c.setData(dataRef.current);
        requestAnimationFrame(() => { if (alive) setGl(true); });
      }, () => { if (alive) setFailed(true); });
    };
    // Idle time after the first paint, so the headline and the page's own requests go first.
    // After the headline has its fonts (the LCP), then in idle time.
    const idle = "requestIdleCallback" in window;
    let h = 0;
    const later = () => { if (alive) h = idle ? window.requestIdleCallback(boot, { timeout: 900 }) : window.setTimeout(boot, 250); };
    if (document.fonts?.ready) document.fonts.ready.then(later, later); else later();
    return () => {
      alive = false;
      if (idle) window.cancelIdleCallback(h); else clearTimeout(h);
      c?.dispose();
      colony.current = null;
      setGl(false);
      setHover(null);
    };
  }, [want3d]);

  useEffect(() => { colony.current?.setData(data); }, [data, gl]);

  // Once the canvas has faded in over the drawing, the drawing (and its CSS motes) leaves the page; a GPU
  // failure brings it back at once (gl turns false).
  useEffect(() => {
    if (!gl) return;
    const t = setTimeout(() => setSettled(true), SETTLE_MS);
    return () => { clearTimeout(t); setSettled(false); };
  }, [gl]);

  // Size, the headline's quiet zone (left 48 % of the viewport keeps a fifth of the spores), the loop.
  useEffect(() => {
    const el = stage.current;
    if (!el || !gl || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const wide = window.innerWidth >= 1024;
      colony.current?.resize(r.width, r.height, wide);
      colony.current?.cull(wide ? ((window.innerWidth * 0.48 - r.left) / Math.max(1, r.width)) * 2 - 1 : -2);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [gl]);
  useEffect(() => {
    const c = colony.current;
    if (!c || !gl) return;
    const sync = () => { if (onScreen && !faded && !document.hidden && !paused) c.start(); else { c.stop(); } };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => { document.removeEventListener("visibilitychange", sync); c.stop(); };
  }, [gl, onScreen, faded, paused]);

  // The pointer leans the camera (the scene reads the shared pointer store each frame); hover finds a node.
  const onMove = (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    const r = e.currentTarget.getBoundingClientRect();
    colony.current?.hoverAt(e.clientX - r.left, e.clientY - r.top);
  };
  const onLeave = () => colony.current?.hoverAt(null);
  const onClick = () => { if (hover) navigate(`/c/${hover.mint}`); };

  // Scroll: the stage fades out by 1.2 screens and drifts a little slower than the page; the camera dollies in.
  useEffect(() => {
    let raf = 0;
    const apply = () => {
      raf = 0;
      // Only where the colony is the arrival's backdrop (desktop); in the flow (tablet, phone) it stays put.
      const hero = window.innerWidth >= 1024;
      const p = hero ? window.scrollY / Math.max(1, window.innerHeight) : 0;
      const el = wrap.current, st = stage.current;
      if (el) el.style.opacity = String(Math.max(0, 1 - p / 1.2).toFixed(3));
      // the drawing lags the page a little (the caption scrolls with the copy)
      if (st) st.style.transform = paused || !hero || p > 1.3 ? "" : `translate3d(0, ${(window.scrollY * 0.12).toFixed(1)}px, 0)`;
      colony.current?.scroll(p);
      setFaded(p >= 1.2);
    };
    const on = () => { if (!raf) raf = requestAnimationFrame(apply); };
    apply();
    window.addEventListener("scroll", on, { passive: true });
    window.addEventListener("resize", on);
    return () => { window.removeEventListener("scroll", on); window.removeEventListener("resize", on); cancelAnimationFrame(raf); };
  }, [paused]);

  // Live: a launch under the tree buds a child (or a grandchild); a trade sends a mote to the root.
  useEvents({
    coin: (c) => {
      const t = treeRef.current, parent = c.parent?.mint;
      if (!t || !parent) return;
      if (parent === t.root.mint) {
        if (t.kids.some((k) => k.mint === c.mint)) return;
        const next = { ...t, kids: [kidOf(c), ...t.kids], count: t.count + 1 };
        treeRef.current = next;
        setTree(next);
        requestAnimationFrame(() => colony.current?.bud(c.mint));
        return;
      }
      const i = t.kids.findIndex((k) => k.mint === parent);
      if (i < 0 || t.kids[i].grand.includes(c.mint)) return;
      const kids = t.kids.slice();
      kids[i] = { ...kids[i], grand: [c.mint, ...kids[i].grand].slice(0, GRAND_PER) };
      const next = { ...t, kids };
      treeRef.current = next;
      setTree(next);
    },
    trade: (t) => { if (onScreen) colony.current?.trade(t.mint, t.isBuy); },
  }, phase === "ready");

  const root = tree?.root;
  const label = root ? `Live family tree of ${tickerOf(root.symbol, root.mint)}: ${plural(tree?.count ?? 0, "child", "children")} around it` : "Live family tree";
  return (
    <figure ref={wrap} className={`colony ${gl ? "is-gl" : "is-svg"} ${phase} ${hover ? "is-hover" : ""} ${className}`} aria-label={label}>
      <div ref={stage} className="colony-stage" onPointerMove={onMove} onPointerLeave={onLeave} onClick={onClick} style={{ cursor: hover ? "pointer" : undefined } as CSSProperties}>
        {!(gl && settled) && <ColonyFallback data={phase === "ready" ? data : null} className={phase === "loading" ? "is-loading" : ""} />}
        {want3d && <canvas ref={canvasRef} className="colony-canvas" aria-hidden="true" />}
        {/* the tickers of the largest children in front (positioned by the scene; the drawing has its own) */}
        {want3d && Array.from({ length: TAGS }, (_, i) => <span key={i} ref={(el) => { tagRefs.current[i] = el; }} className="colony-tag" aria-hidden="true" />)}
        <span ref={tipRef} className={`colony-tip ${hover ? "on" : ""} ${hover?.root ? "root" : ""}`} aria-hidden="true"><b>{hover?.label}</b>{hover && <i>{hover.root ? "root · open" : "open"}</i>}</span>
      </div>
      {/* Keyboard: the children as links, hidden until focus enters them, then a small glass list */}
      {phase === "ready" && root && tree && tree.kids.length > 0 && (
        <nav className="colony-keys" aria-label={`Children of ${tickerOf(root.symbol, root.mint)}`}
          onFocus={(e) => colony.current?.focus((e.target as HTMLElement).dataset.mint ?? null)} onBlur={() => colony.current?.focus(null)}>
          {tree.kids.slice(0, MAX_KIDS).map((k) => <Link key={k.mint} to={`/c/${k.mint}`} data-mint={k.mint}><b>{tickerOf(k.symbol, k.mint)}</b><span>{k.name}</span></Link>)}
        </nav>
      )}
      <figcaption className="colony-cap">
        {phase === "ready" && root ? (
          <>
            <span className="colony-cap-text">
              <Link to={`/c/${root.mint}`} className="colony-cap-root">{tickerOf(root.symbol, root.mint)}</Link>
              <span>{plural(tree?.count ?? 0, "child", "children")}</span>
              <span><b className={(root.lockedUsd ?? 0) > 0 ? "accent" : "faint"}>{usdCard(root.lockedUsd)}</b> <Term k="locked">locked</Term></span>
              <LiveDot short />
            </span>
            <Link to={`/map?focus=${root.mint}`} className="colony-cap-map">Open on the map <span aria-hidden="true">→</span></Link>
          </>
        ) : phase === "error" ? (
          <span className="colony-cap-text colony-note">Live tree unavailable, retrying</span>
        ) : phase === "empty" ? (
          <>
            <span className="colony-cap-text">No trees yet: the first coin launched under a root starts one.</span>
            <Link to="/launch" className="colony-cap-map">Launch a root <span aria-hidden="true">→</span></Link>
          </>
        ) : (
          <span className="colony-cap-text"><span className="sk colony-cap-sk" aria-hidden="true" /><span className="sr-only">Finding the biggest tree</span></span>
        )}
        <span className="colony-eyebrow" aria-hidden="true">{phase === "ready" ? "The biggest tree, live" : phase === "loading" ? "Finding the biggest tree" : "What a tree looks like"}</span>
      </figcaption>
    </figure>
  );
}
