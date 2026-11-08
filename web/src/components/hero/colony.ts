// The colony (DESIGN-ELEVATE §7): the biggest tree on Spore as a living 3D portrait. No React here:
// SporeColony.tsx creates it on a canvas, feeds it the tree and the live events, and starts or stops
// its loop (off-screen, hidden tab, paused motion). Draw calls: root 1 · children 1 (instanced) ·
// filaments 1 (merged) · grandchildren 1 · motes 1 · spores 1, plus the bloom chain.
//
// Geometry is built once. Children are added and removed by scaling; filaments bend in the vertex
// shader toward each child's live position, so a refresh morphs and a launch buds without new buffers.
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, CanvasTexture, Clock, Color, Group, InstancedBufferAttribute, InstancedMesh, Matrix4,
  Mesh, PerspectiveCamera, Points, Quaternion, SRGBColorSpace, Scene, ShaderMaterial, SphereGeometry, Texture, TextureLoader,
  Vector2, Vector3, Vector4, WebGLRenderer,
} from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
// three is declared loosely (three-modules.d.ts); these aliases keep the scene's own shapes readable.
type V3 = InstanceType<typeof Vector3>; type Tex = InstanceType<typeof Texture>; type Attr = InstanceType<typeof BufferAttribute>;
type Composer = InstanceType<typeof EffectComposer>; type Bloom = InstanceType<typeof UnrealBloomPass>;
import { DOT_FRAG, DOT_VERT, FIELD_FRAG, FIELD_VERT, FIL_FRAG, FIL_VERT, KID_FRAG, KID_VERT, ROOT_FRAG, ROOT_VERT } from "./shaders";

export const MAX_KIDS = 12;
const GRAND_PER = 3, MAX_GRAND = MAX_KIDS * GRAND_PER, MOTES = 8;
const ROOT_R = 0.7, TILT = (22 * Math.PI) / 180, SPIN = 0.035, MOTE_S = 1.5, BUD_S = 1.4;
/** Children's radius range (world units): the log of what each one locks maps onto it, smallest to largest. */
const KID_R0 = 0.1, KID_R1 = 0.232;
/** Filaments leave the root just outside its silhouette (never across its face). */
const FIL_R0 = ROOT_R * 1.04;

export type ColonyKid = { mint: string; label: string; weight: number; grand: string[]; image?: string | null };
export type ColonyData = { root: { mint: string; label: string; image: string | null }; kids: ColonyKid[] };
export type ColonyHover = { mint: string; label: string; root: boolean } | null;
export type ColonyOptions = {
  /** Phone path: fewer spores, no bloom, dpr 1. */
  lite: boolean;
  /** The clip-space x left of which only a fifth of the spores draw (the headline's side). */
  cullX?: number;
  /** Called when the GPU context is lost: the shell swaps in the drawn fallback. */
  onLost: () => void;
  /** Called when the hovered node changes. */
  onHover: (h: ColonyHover) => void;
  /** Element whose transform follows the hovered node (an HTML label). */
  label?: HTMLElement | null;
  /** A live pointer (0..1 of the viewport, e.g. lib/motion usePointer()), read once per frame. */
  pointer?: { x: number; y: number } | null;
  /** A small pool of HTML tags: the largest children in front carry their ticker (projected per frame). */
  tags?: HTMLElement[];
};
export type Colony = {
  setData(d: ColonyData | null): void;
  bud(mint: string): void;
  trade(mint: string, buy: boolean): boolean;
  pointer(x: number, y: number): void;
  hoverAt(px: number | null, py?: number): void;
  /** Keyboard focus on a child (its link has focus): highlighted and labelled as if hovered. */
  focus(mint: string | null): void;
  scroll(p: number): void;
  /** `hero`: the colony is the arrival's backdrop (desktop), framed by height so it never crowds the copy. */
  resize(w: number, h: number, hero?: boolean): void;
  start(): void;
  stop(): void;
  frame(): void;
  stats(): { fps: number; level: number; spores: number };
  cull(x: number): void;
  dispose(): void;
};

const COL = { lime: new Color("#b6ff5c"), teal: new Color("#5ce0c8"), violet: new Color("#b08cff"), deep: new Color("#04110a"), sell: new Color("#ff6b7a"), bg: new Color("#030704") };
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };

/// `u`: where the child sits along the ring (0..1 of its length as the camera sees it), gliding to `uTo`;
/// `ext`: how far out from the root it has grown (a newborn starts close and moves out).
type Slot = { mint: string | null; label: string; pos: V3; u: number; uTo: number; ext: number; rad: number; yOff: number; r: number; rTo: number; grow: number; glow: number; born: number; grand: string[]; image: string | null };
/// `dy`: a second row (px) when the first would touch a neighbour's tag; `y` eases toward it.
type Tag = { el: HTMLElement; slot: number; mint: string | null; on: boolean; off: number; dy: number; y: number };

export function createColony(canvas: HTMLCanvasElement, opts: ColonyOptions): Colony {
  const lite = opts.lite;
  // A software rasteriser would run this at a few frames a second: refuse it and let the shell draw the fallback.
  const renderer = new WebGLRenderer({ canvas, antialias: lite, alpha: false, powerPreference: "high-performance", failIfMajorPerformanceCaveat: true, stencil: false });
  const dpr = lite ? 1 : Math.min(1.5, window.devicePixelRatio || 1);
  renderer.setPixelRatio(dpr);
  renderer.setClearColor(COL.bg, 1);
  renderer.outputColorSpace = SRGBColorSpace;

  const scene = new Scene();
  const camera = new PerspectiveCamera(34, 1, 0.1, 80);
  const DIST = 11.6;
  camera.position.set(0, 0.4, DIST);

  const disposables: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(x: T) => { disposables.push(x); return x; };

  /* ---------- root */
  const rootU = { uTime: { value: 0 }, uTex: { value: null as Tex | null }, uHasTex: { value: 0 }, uPulse: { value: 0 }, uHover: { value: 0 }, uLime: { value: COL.lime }, uTeal: { value: COL.teal }, uDeep: { value: COL.deep } };
  const root = new Mesh(own(new SphereGeometry(1, 64, 48)), own(new ShaderMaterial({ vertexShader: ROOT_VERT, fragmentShader: ROOT_FRAG, uniforms: rootU })));
  root.scale.setScalar(ROOT_R);
  scene.add(root);

  /* ---------- the ring: children, filaments and grandchildren turn together */
  const ring = new Group();
  ring.rotation.x = TILT;
  scene.add(ring);

  const kidGeo = own(new SphereGeometry(1, 32, 24));
  const glowAttr = new InstancedBufferAttribute(new Float32Array(MAX_KIDS), 1);
  kidGeo.setAttribute("aGlow", glowAttr);
  const tileAttr = new InstancedBufferAttribute(new Float32Array(MAX_KIDS).fill(-1), 1);
  kidGeo.setAttribute("aTile", tileAttr);
  // the children's logos: one 4 × 3 atlas of 128 px tiles, a tile per slot, drawn as each image arrives
  const TILE = 128;
  const atlasCanvas = document.createElement("canvas");
  atlasCanvas.width = TILE * 4; atlasCanvas.height = TILE * 3;
  const atlasCtx = atlasCanvas.getContext("2d");
  const atlas = own(new CanvasTexture(atlasCanvas));
  atlas.colorSpace = SRGBColorSpace;
  const kids = new InstancedMesh(kidGeo, own(new ShaderMaterial({ vertexShader: KID_VERT, fragmentShader: KID_FRAG, uniforms: { uTeal: { value: COL.teal }, uLime: { value: COL.lime }, uDeep: { value: COL.deep }, uAtlas: { value: atlas } } })), MAX_KIDS);
  kids.frustumCulled = false;
  ring.add(kids);

  // filaments: MAX_KIDS canonical tubes, 40 segments × 4 sides each
  const SEG = 40, SIDES = 4;
  const filGeo = own(new BufferGeometry());
  {
    const per = (SEG + 1) * SIDES, n = per * MAX_KIDS;
    const aT = new Float32Array(n), aAng = new Float32Array(n), aKid = new Float32Array(n), pos = new Float32Array(n * 3);
    const idx: number[] = [];
    for (let k = 0; k < MAX_KIDS; k++) {
      for (let s = 0; s <= SEG; s++) for (let a = 0; a < SIDES; a++) {
        const v = k * per + s * SIDES + a;
        aT[v] = s / SEG; aAng[v] = (a / SIDES) * Math.PI * 2; aKid[v] = k;
      }
      for (let s = 0; s < SEG; s++) for (let a = 0; a < SIDES; a++) {
        const i0 = k * per + s * SIDES + a, i1 = k * per + s * SIDES + ((a + 1) % SIDES), i2 = i0 + SIDES, i3 = i1 + SIDES;
        idx.push(i0, i2, i1, i1, i2, i3);
      }
    }
    filGeo.setAttribute("position", new BufferAttribute(pos, 3));
    filGeo.setAttribute("aT", new BufferAttribute(aT, 1));
    filGeo.setAttribute("aAng", new BufferAttribute(aAng, 1));
    filGeo.setAttribute("aKid", new BufferAttribute(aKid, 1));
    filGeo.setIndex(idx);
  }
  const filU = { uKid: { value: Array.from({ length: MAX_KIDS }, () => new Vector4()) }, uGrow: { value: Array.from({ length: MAX_KIDS }, () => 0) }, uTime: { value: 0 }, uWidth: { value: lite ? 1.4 : 1 }, uLime: { value: COL.lime }, uTeal: { value: COL.teal }, uView: { value: new Vector3(0, 0, 1) }, uRootR: { value: FIL_R0 } };
  const fil = new Mesh(filGeo, own(new ShaderMaterial({ vertexShader: FIL_VERT, fragmentShader: FIL_FRAG, uniforms: filU, transparent: true, blending: AdditiveBlending, depthWrite: false })));
  fil.frustumCulled = false;
  ring.add(fil);

  const pxU = { value: (lite ? 1 : dpr) * 46 };
  const dotGeo = (n: number) => {
    const g = own(new BufferGeometry());
    g.setAttribute("position", new BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute("aColor", new BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute("aSize", new BufferAttribute(new Float32Array(n), 1));
    return g;
  };
  const dotMat = own(new ShaderMaterial({ vertexShader: DOT_VERT, fragmentShader: DOT_FRAG, uniforms: { uPx: pxU }, transparent: true, blending: AdditiveBlending, depthWrite: false }));
  const grandGeo = dotGeo(MAX_GRAND);
  const grand = new Points(grandGeo, dotMat);
  grand.frustumCulled = false;
  ring.add(grand);
  const moteGeo = dotGeo(MOTES);
  // motes are light: never hidden behind a child bead
  const moteMat = own(new ShaderMaterial({ vertexShader: DOT_VERT, fragmentShader: DOT_FRAG, uniforms: { uPx: pxU }, transparent: true, blending: AdditiveBlending, depthWrite: false, depthTest: false }));
  const motesPts = new Points(moteGeo, moteMat);
  motesPts.renderOrder = 2;
  motesPts.frustumCulled = false;
  ring.add(motesPts);

  /* ---------- the spore field */
  const FULL = lite ? 1200 : 3200;
  const fieldGeo = own(new BufferGeometry());
  {
    const p = new Float32Array(FULL * 3), s = new Float32Array(FULL * 4);
    let a = 1234567;
    const rnd = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
    for (let i = 0; i < FULL; i++) {
      // denser near the colony, thinning out into the void
      const u = rnd(), r = 1.6 + Math.pow(u, 0.7) * 9.5, th = rnd() * Math.PI * 2;
      p[i * 3] = Math.cos(th) * r * 1.25 - 0.6;
      p[i * 3 + 1] = (rnd() - 0.5) * 10;
      p[i * 3 + 2] = Math.sin(th) * r * 0.9 - 2.4;
      s[i * 4] = rnd(); s[i * 4 + 1] = rnd(); s[i * 4 + 2] = rnd(); s[i * 4 + 3] = Math.pow(rnd(), 2.2);
    }
    fieldGeo.setAttribute("position", new BufferAttribute(p, 3));
    fieldGeo.setAttribute("aSeed", new BufferAttribute(s, 4));
  }
  const fieldU = { uTime: { value: 0 }, uPx: { value: (lite ? 1 : dpr) * 22 }, uCullX: { value: opts.cullX ?? -2 }, uLime: { value: COL.lime }, uTeal: { value: COL.teal }, uViolet: { value: COL.violet } };
  const field = new Points(fieldGeo, own(new ShaderMaterial({ vertexShader: FIELD_VERT, fragmentShader: FIELD_FRAG, uniforms: fieldU, transparent: true, blending: AdditiveBlending, depthWrite: false })));
  field.frustumCulled = false;
  scene.add(field);

  /* ---------- post */
  let composer: Composer | null = null, bloom: Bloom | null = null;
  if (!lite) {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    bloom = new UnrealBloomPass(new Vector2(256, 256), 0.9, 0.6, 0.55);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
  }

  /* ---------- state */
  const slots: Slot[] = Array.from({ length: MAX_KIDS }, () => ({ mint: null, label: "", pos: new Vector3(), u: 0, uTo: 0, ext: 1, rad: 1, yOff: 0, r: 0, rTo: 0, grow: 0, glow: 0, born: 0, grand: [], image: null }));
  let data: ColonyData | null = null;
  let rootMint = "", rootLabel = "";
  let texUrl: string | null = null;
  const loader = new TextureLoader();
  loader.setCrossOrigin("anonymous");
  const motes = Array.from({ length: MOTES }, () => ({ live: false, t0: 0, from: new Vector3(), via: null as V3 | null, slot: -1, buy: true }));
  let lastMote = 0;

  const clock = new Clock(false);
  let time = 0, raf = 0, running = false, disposed = false;
  let w = 1, h = 1;
  const ptr = { x: 0, y: 0 }, cam = { yaw: 0, vyaw: 0, pitch: 0, vpitch: 0 }, drift = { x: 0, y: 0 };
  let scrollP = 0, dist0 = DIST;
  let hover: { px: number; py: number } | null = null, hovered = -2; // -2 none, -1 root, else a slot
  let focusMint: string | null = null;
  let level = 0, slowFor = 0, fpsEma = 60;
  let phase = 0, hero = false;

  // The ring as the camera sees it: an ellipse (the 22° tilt, plus perspective). Children are spaced by
  // equal steps of that projected length, not of angle, so neighbours never crowd at its sides, and the
  // turn advances them all along it together.
  let ringR = 0, lut = new Float32Array(0);
  function buildLut(R: number) {
    const N = 512, M = 256, D = DIST, sT = Math.sin(TILT + 0.03), cT = Math.cos(TILT);
    const cum = new Float32Array(N + 1);
    let px = 0, py = 0;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2, f = D / (D - R * Math.sin(a) * cT);
      const x = R * Math.cos(a) * f, y = R * Math.sin(a) * sT * f;
      if (i) cum[i] = cum[i - 1] + Math.hypot(x - px, y - py);
      px = x; py = y;
    }
    const out = new Float32Array(M + 1), total = cum[N];
    let j = 0;
    for (let k = 0; k <= M; k++) {
      const want = (k / M) * total;
      while (j < N - 1 && cum[j + 1] < want) j++;
      const seg = cum[j + 1] - cum[j] || 1;
      out[k] = ((j + Math.min(1, Math.max(0, (want - cum[j]) / seg))) / N) * Math.PI * 2;
    }
    ringR = R; lut = out;
  }
  /** The ring angle at `u` (0..1, wrapping) of its projected length. */
  const angleAt = (u: number) => { const x = (u - Math.floor(u)) * (lut.length - 1), i = Math.floor(x), f = x - i; return lut[i] + (lut[Math.min(i + 1, lut.length - 1)] - lut[i]) * f; };

  function layout() {
    const list: ColonyKid[] = data ? data.kids.slice(0, MAX_KIDS) : Array.from({ length: 8 }, (_, i) => ({ mint: `placeholder-${i}`, label: "", weight: 1, grand: [] as string[] }));
    const n = list.length;
    const ws = list.map((k) => Math.log1p(Math.max(0, k.weight)));
    // the spread of this tree's own values, so the smallest and the largest child differ visibly
    const lo = Math.min(...ws), hi = Math.max(...ws);
    const R = n <= 6 ? 1.95 : 2.3;
    if (R !== ringR) buildLut(R);
    const keep = new Map(slots.map((s, i) => [s.mint, i] as const));
    const used = new Set<number>();
    const assign: number[] = list.map((k) => { const i = keep.get(k.mint); if (i !== undefined && !used.has(i)) { used.add(i); return i; } return -1; });
    // new mints take the free slots
    for (let j = 0; j < n; j++) if (assign[j] < 0) { const i = slots.findIndex((_, s) => !used.has(s)); used.add(i); assign[j] = i; }
    slots.forEach((s, i) => { if (!used.has(i)) { s.rTo = 0; tileFor(i, null); } });
    list.forEach((k, j) => {
      const s = slots[assign[j]];
      const wob = hash(k.mint) - 0.5;
      s.uTo = j / n + 0.06;
      s.rad = 1 + wob * 0.06; s.yOff = wob * 0.2;
      s.rTo = hi > lo ? KID_R0 + ((ws[j] - lo) / (hi - lo)) * (KID_R1 - KID_R0) : (KID_R0 + KID_R1) / 2;
      if (s.mint !== k.mint) {
        const fresh = s.mint === null || s.r < 0.01;
        s.mint = k.mint;
        if (fresh) { s.u = s.uTo; s.ext = 0.15; s.grow = 0; s.r = 0; s.born = time; }
      }
      s.label = k.label;
      s.grand = k.grand.slice(0, GRAND_PER);
      tileFor(assign[j], k.image ?? null);
    });
  }

  /** Draws slot i's logo into its atlas tile (cover-fit, round), or clears the tile. */
  function tileFor(i: number, url: string | null) {
    const s = slots[i];
    if (s.image === url) return;
    s.image = url;
    tileAttr.setX(i, -1); tileAttr.needsUpdate = true;
    const x = (i % 4) * TILE, y = Math.floor(i / 4) * TILE;
    atlasCtx?.clearRect(x, y, TILE, TILE);
    if (!url || !atlasCtx) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => {
      if (disposed || s.image !== url) return;
      const k = Math.max(TILE / img.naturalWidth, TILE / img.naturalHeight), w2 = img.naturalWidth * k, h2 = img.naturalHeight * k;
      atlasCtx.save();
      atlasCtx.beginPath(); atlasCtx.arc(x + TILE / 2, y + TILE / 2, TILE / 2, 0, Math.PI * 2); atlasCtx.clip();
      atlasCtx.drawImage(img, x + (TILE - w2) / 2, y + (TILE - h2) / 2, w2, h2);
      atlasCtx.restore();
      atlas.needsUpdate = true;
      tileAttr.setX(i, i); tileAttr.needsUpdate = true;
      if (!running) frame();
    };
    img.src = url;
  }

  function setTexture(url: string | null) {
    if (url === texUrl) return;
    texUrl = url;
    rootU.uHasTex.value = 0;
    rootU.uTex.value?.dispose();
    rootU.uTex.value = null;
    if (!url) return;
    loader.load(url, (t: Tex) => {
      if (disposed || texUrl !== url) { t.dispose(); return; }
      t.colorSpace = SRGBColorSpace;
      rootU.uTex.value = t;
      rootU.uHasTex.value = 1;
      if (!running) frame();
    }, undefined, () => { /* a broken logo: the sphere keeps its inner light */ });
  }

  const m4 = new Matrix4(), q = new Quaternion(), sv = new Vector3(), tmp = new Vector3();
  const grandPos = grandGeo.getAttribute("position") as Attr, grandCol = grandGeo.getAttribute("aColor") as Attr, grandSize = grandGeo.getAttribute("aSize") as Attr;
  const motePos = moteGeo.getAttribute("position") as Attr, moteCol = moteGeo.getAttribute("aColor") as Attr, moteSize = moteGeo.getAttribute("aSize") as Attr;

  // the camera's direction in ring space (the root is the ring's origin), refreshed each frame
  const viewL = new Vector3(0, 0, 1), st = new Vector3();
  /** Where a filament leaves the root: just outside its silhouette, on the side facing the child. */
  function filStart(end: V3, out: V3) {
    out.copy(end).addScaledVector(viewL, -end.dot(viewL));
    const l = out.length();
    return l < 1e-4 ? out.set(0, -FIL_R0, 0) : out.multiplyScalar(FIL_R0 / l);
  }
  /** Where a filament is at t (0 root's rim → 1 child), in ring space: the same curve as FIL_VERT. */
  function onFil(end: V3, t: number, out: V3) {
    const a = filStart(end, st);
    const dx = end.x - a.x, dy = end.y - a.y, dz = end.z - a.z, L = Math.hypot(dx, dy, dz);
    const nl = Math.hypot(dz, dx) || 1;
    const mx = a.x + dx * 0.5 - (dz / nl) * L * 0.08, my = a.y + dy * 0.5 + L * 0.07, mz = a.z + dz * 0.5 + (dx / nl) * L * 0.08;
    const u = 1 - t;
    return out.set(u * u * a.x + 2 * u * t * mx + t * t * end.x, u * u * a.y + 2 * u * t * my + t * t * end.y, u * u * a.z + 2 * u * t * mz + t * t * end.z);
  }

  function step(dt: number) {
    time += dt;
    rootU.uTime.value = time; filU.uTime.value = time; fieldU.uTime.value = time;
    rootU.uPulse.value = Math.max(0, rootU.uPulse.value - dt * 1.6);
    rootU.uHover.value += ((hovered === -1 ? 1 : 0) - rootU.uHover.value) * Math.min(1, dt * 8);

    // camera: 6° yaw / 4° pitch toward the pointer on a spring; the colony follows with ~1.2 s of lag
    if (opts.pointer) { ptr.x = opts.pointer.x * 2 - 1; ptr.y = opts.pointer.y * 2 - 1; }
    [cam.yaw, cam.vyaw] = springStep(cam.yaw, cam.vyaw, ptr.x * 0.105, dt);
    [cam.pitch, cam.vpitch] = springStep(cam.pitch, cam.vpitch, -ptr.y * 0.07, dt);
    const lag = 1 - Math.exp(-dt / 1.2);
    drift.x += (ptr.x * 0.22 - drift.x) * lag; drift.y += (-ptr.y * 0.14 - drift.y) * lag;
    const dist = dist0 * (1 - 0.08 * Math.min(1, scrollP));
    camera.position.set(Math.sin(cam.yaw) * dist, 0.4 + Math.sin(cam.pitch) * dist, Math.cos(cam.yaw) * dist);
    camera.lookAt(0, 0.1, 0);
    root.position.set(drift.x, drift.y, 0);
    ring.position.copy(root.position);
    ring.updateMatrixWorld();
    ring.worldToLocal(viewL.copy(camera.position)).normalize();
    filU.uView.value.copy(viewL);
    // the turn: every child advances along the ring together (a full turn in about three minutes)
    phase += (dt * SPIN) / (Math.PI * 2);

    // children glide to their places; new ones bud
    const kidVec = filU.uKid.value;
    let gi = 0;
    slots.forEach((s, i) => {
      const k = 1 - Math.exp(-dt * 2.4);
      const du = s.uTo - s.u;
      s.u += (du - Math.round(du)) * k;
      s.ext += (1 - s.ext) * k;
      const a = angleAt(s.u + phase), rr = ringR * s.rad * s.ext;
      s.pos.set(Math.cos(a) * rr, s.yOff * s.ext, Math.sin(a) * rr);
      s.r += (s.rTo - s.r) * (1 - Math.exp(-dt * 3));
      if (s.rTo === 0 && s.r < 0.004) { s.r = 0; s.mint = null; }
      const since = time - s.born;
      s.grow = s.rTo > 0 ? Math.min(1, s.grow + dt / BUD_S) : Math.max(0, s.grow - dt * 1.5);
      const bud = since < BUD_S ? 1 + Math.sin(Math.min(1, since / BUD_S) * Math.PI) * 0.35 : 1;
      const want = (hovered === i ? 1 : 0) + (since < BUD_S * 1.6 ? 1 - since / (BUD_S * 1.6) : 0);
      s.glow += (Math.min(1, want) - s.glow) * Math.min(1, dt * 8);
      const shown = s.r * bud * (s.grow < 0.85 ? s.grow / 0.85 : 1);
      m4.compose(s.pos, q, sv.setScalar(Math.max(1e-4, shown)));
      kids.setMatrixAt(i, m4);
      glowAttr.setX(i, s.glow);
      kidVec[i].set(s.pos.x, s.pos.y, s.pos.z, s.r);
      filU.uGrow.value[i] = s.mint ? s.grow : 0;
      // grandchildren: violet points just beyond their parent, fanned
      const out = tmp.copy(s.pos).setY(0).normalize();
      s.grand.forEach((_, j) => {
        if (gi >= MAX_GRAND) return;
        const ang = [0, -0.5, 0.5][j];
        const c = Math.cos(ang), sn = Math.sin(ang), d = s.r + 0.24;
        grandPos.setXYZ(gi, s.pos.x + (out.x * c - out.z * sn) * d, s.pos.y + 0.06 * (j - 1), s.pos.z + (out.x * sn + out.z * c) * d);
        grandCol.setXYZ(gi, COL.violet.r * 1.9, COL.violet.g * 1.9, COL.violet.b * 1.9);
        grandSize.setX(gi, s.mint ? 5.2 * s.grow : 0);
        gi++;
      });
    });
    for (let i = gi; i < MAX_GRAND; i++) grandSize.setX(i, 0);
    kids.instanceMatrix.needsUpdate = true; glowAttr.needsUpdate = true;
    grandPos.needsUpdate = true; grandCol.needsUpdate = true; grandSize.needsUpdate = true;

    // trade motes travel the filament from the child to the root (a grandchild's first hops to its parent);
    // the filament begins at the root's rim, so a mote arrives there and the root pulses
    motes.forEach((m, i) => {
      if (!m.live) { moteSize.setX(i, 0); return; }
      const s = slots[m.slot];
      const u = (time - m.t0) / MOTE_S;
      if (u >= 1 || !s || !s.mint) { m.live = false; moteSize.setX(i, 0); if (u >= 1) rootU.uPulse.value = 1; return; }
      const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      if (m.via) {
        if (e < 0.3) tmp.copy(m.via).lerp(s.pos, e / 0.3);
        else onFil(s.pos, 1 - (e - 0.3) / 0.7, tmp);
      } else onFil(s.pos, 1 - e, tmp);
      motePos.setXYZ(i, tmp.x, tmp.y, tmp.z);
      const c = m.buy ? COL.lime : COL.sell;
      moteCol.setXYZ(i, c.r * 1.6, c.g * 1.6, c.b * 1.6);
      moteSize.setX(i, 5.5 * Math.sin(Math.min(1, u * 1.08) * Math.PI) + 2);
    });
    motePos.needsUpdate = true; moteCol.needsUpdate = true; moteSize.needsUpdate = true;

    pick();
    tagsStep(dt);
  }

  function springStep(p: number, v: number, to: number, dt: number): [number, number] {
    const steps = Math.max(1, Math.ceil(dt * 120)), hh = dt / steps;
    for (let i = 0; i < steps; i++) { const a = -60 * (p - to) - 15 * v; v += a * hh; p += v * hh; }
    return [p, v];
  }

  const proj = new Vector3();
  function toScreen(local: V3 | null, out: { x: number; y: number }) {
    if (local) { proj.copy(local); ring.localToWorld(proj); } else proj.copy(root.position);
    proj.project(camera);
    out.x = (proj.x * 0.5 + 0.5) * w; out.y = (-proj.y * 0.5 + 0.5) * h;
    return proj.z < 1;
  }
  const scr = { x: 0, y: 0 };
  /** Pixels per world unit at the colony's distance. */
  const unitPx = () => h / (2 * Math.tan((camera.fov * Math.PI) / 360) * dist0);
  function pick() {
    let best = -2, bestD = Infinity;
    const fi = focusMint ? slots.findIndex((x) => x.mint === focusMint) : -1;
    if (fi >= 0) best = fi;
    else if (hover && data) {
      toScreen(null, scr);
      const rootPx = unitPx() * ROOT_R;
      const dr = Math.hypot(scr.x - hover.px, scr.y - hover.py);
      if (dr < rootPx + 10) { best = -1; bestD = dr; }
      slots.forEach((s, i) => {
        if (!s.mint || s.r < 0.05) return;
        toScreen(s.pos, scr);
        const d = Math.hypot(scr.x - hover!.px, scr.y - hover!.py);
        if (d < Math.max(18, s.r * unitPx() + 8) && d < bestD) { best = i; bestD = d; }
      });
    }
    if (best !== hovered) {
      hovered = best;
      opts.onHover(best === -2 ? null : best === -1 ? { mint: rootMint, label: rootLabel, root: true } : { mint: slots[best].mint!, label: slots[best].label, root: false });
    }
    if (opts.label && hovered !== -2) {
      toScreen(hovered === -1 ? null : slots[hovered].pos, scr);
      const lift = (hovered === -1 ? ROOT_R : slots[hovered].r) * unitPx() + 12;
      opts.label.style.transform = `translate3d(${scr.x.toFixed(1)}px, ${(scr.y - lift).toFixed(1)}px, 0)`;
    }
  }

  /* ---------- persistent tags: the largest children in front carry their ticker, away from the headline */
  const tags: Tag[] = (opts.tags ?? []).map((el) => ({ el, slot: -1, mint: null, on: false, off: -1, dy: 0, y: 0 }));
  const tagS = { x: 0, y: 0 };
  let tagWait = 0;
  /** Can slot i carry a tag? `enter` is the stricter test for a new tag, so one does not flicker at the edge. */
  /** The tagged side of the ring: the larger children only (the upper part of this tree's range). */
  const TAG_MIN_R = KID_R0 + 0.4 * (KID_R1 - KID_R0);
  /** The projected radius of slot i in px (front children are closer, so larger). */
  const discPx = (s: Slot, px: number) => s.r * px * (1 + Math.max(0, s.pos.z) * 0.09);
  function tagFits(i: number, enter: boolean) {
    const s = slots[i];
    if (!s.mint || !s.label || s.r < 0.05 || s.rTo < TAG_MIN_R || s.grow < 0.9 || hovered === i) return false;
    if (s.pos.z / (ringR * s.rad) < (enter ? 0.14 : 0.02)) return false; // in front of the root
    toScreen(s.pos, tagS);
    const minX = hero ? w * 0.34 : 28;
    return tagS.x > minX - (enter ? 0 : 30) && tagS.x < w - 28;
  }
  function tagsStep(dt: number) {
    if (!tags.length) return;
    tagWait -= dt;
    if (tagWait <= 0) {
      tagWait = 0.4;
      const held = new Set(tags.filter((t) => t.on).map((t) => t.slot));
      // the tags already shown first (no flapping), then the largest; a tag that would touch one already
      // placed is skipped (a mono 11 px label is about 6.7 px a character plus its padding)
      // and a tag never covers another child's sphere
      const px = unitPx();
      const discs = slots.map((s) => { if (!s.mint || s.r < 0.02) return null; toScreen(s.pos, tagS); return [tagS.x, tagS.y, discPx(s, px)] as const; });
      const order = slots.map((_, i) => i).sort((a, b) => Number(held.has(b)) - Number(held.has(a)) || slots[b].rTo - slots[a].rTo);
      const pick: number[] = [], rows = new Map<number, number>(), boxes: [number, number, number][] = [];
      for (const i of order) {
        if (pick.length >= tags.length || !tagFits(i, !held.has(i))) continue;
        const half = (slots[i].label.length * 6.7 + 16) / 2, x = tagS.x, y0 = tagS.y + discPx(slots[i], px) + 16; // the tag's centre
        // the first row under the child, else a second row 22 px lower (dense rings on small screens)
        const dy = [0, 22].find((d) => {
          const y = y0 + d;
          return !boxes.some(([bx, by, bh]) => Math.abs(bx - x) < bh + half + 6 && Math.abs(by - y) < 21)
            && !discs.some((c, j) => c !== null && j !== i && Math.abs(c[0] - x) < half + c[2] + 2 && Math.abs(c[1] - y) < 9 + c[2] + 2);
        });
        if (dy === undefined) continue;
        pick.push(i); rows.set(i, dy); boxes.push([x, y0 + dy, half]);
      }
      const chosen = new Set(pick);
      tags.forEach((t) => { if (t.on && chosen.has(t.slot)) t.dy = rows.get(t.slot) ?? 0; });
      tags.forEach((t) => { if (t.on && !chosen.has(t.slot)) { t.on = false; t.off = time; } });
      for (const i of pick) {
        if (tags.some((t) => t.on && t.slot === i)) continue;
        const t = tags.find((x) => !x.on && (x.slot < 0 || time - x.off > 0.4));
        if (!t) break;
        Object.assign(t, { slot: i, mint: slots[i].mint, on: true, dy: rows.get(i) ?? 0, y: rows.get(i) ?? 0 });
        t.el.textContent = slots[i].label;
      }
    }
    const px = unitPx();
    tags.forEach((t) => {
      if (t.slot < 0) return;
      const s = slots[t.slot];
      if (t.on && (hovered === t.slot || s.mint !== t.mint)) { t.on = false; t.off = time; }
      t.el.classList.toggle("on", t.on);
      if (!t.on && time - t.off > 0.4) { t.slot = -1; return; }
      toScreen(s.pos, tagS);
      t.y += (t.dy - t.y) * Math.min(1, dt * 6);
      const lift = discPx(s, px) + 7 + t.y;
      t.el.style.transform = `translate3d(${tagS.x.toFixed(1)}px, ${(tagS.y + lift).toFixed(1)}px, 0)`;
    });
  }

  function render() {
    if (composer && level < 2) composer.render();
    else renderer.render(scene, camera);
  }

  function loop() {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.05, clock.getDelta());
    step(dt);
    render();
    // adaptive quality: 1 s over 20 ms per frame halves the spores, then drops the bloom
    const ms = dt * 1000;
    fpsEma += (1000 / Math.max(1, ms) - fpsEma) * 0.05;
    if (ms > 20) { slowFor += dt; if (slowFor > 1 && level < 2) { level++; slowFor = 0; if (level === 1) fieldGeo.setDrawRange(0, FULL >> 1); } }
    else slowFor = Math.max(0, slowFor - dt * 0.5);
  }

  function frame() { step(0); render(); }

  const onLost = (e: Event) => { e.preventDefault(); stop(); opts.onLost(); };
  canvas.addEventListener("webglcontextlost", onLost);

  function stop() { if (!running) return; running = false; cancelAnimationFrame(raf); clock.stop(); }

  layout();
  return {
    setData(d) {
      data = d;
      rootMint = d?.root.mint ?? ""; rootLabel = d?.root.label ?? "";
      setTexture(d?.root.image ?? null);
      layout();
      if (!running) { for (let i = 0; i < 90; i++) step(1 / 30); render(); }
    },
    bud(mint) {
      const s = slots.find((x) => x.mint === mint);
      if (s) { s.born = time; s.grow = 0; }
    },
    trade(mint, buy) {
      if (!running) return false;
      if (mint === rootMint) { rootU.uPulse.value = 1; return true; }
      let slot = slots.findIndex((s) => s.mint === mint), via: V3 | null = null;
      if (slot < 0) {
        slot = slots.findIndex((s) => s.grand.includes(mint));
        if (slot < 0) return false;
        const s = slots[slot], j = s.grand.indexOf(mint), ang = [0, -0.5, 0.5][j], c = Math.cos(ang), sn = Math.sin(ang), out = tmp.copy(s.pos).setY(0).normalize(), d = s.r + 0.24;
        via = new Vector3(s.pos.x + (out.x * c - out.z * sn) * d, s.pos.y, s.pos.z + (out.x * sn + out.z * c) * d);
      }
      if (time - lastMote < 0.3) return false;
      const m = motes.find((x) => !x.live);
      if (!m) return false;
      lastMote = time;
      Object.assign(m, { live: true, t0: time, slot, via, buy });
      return true;
    },
    pointer(x, y) { ptr.x = x; ptr.y = y; },
    focus(mint) { focusMint = mint; if (!running) pick(); },
    hoverAt(px, py) { hover = px === null ? null : { px, py: py ?? 0 }; if (!running) { pick(); } },
    scroll(p) { scrollP = p; },
    resize(nw, nh, isHero = false) {
      w = Math.max(1, nw); h = Math.max(1, nh);
      hero = isHero;
      renderer.setSize(w, h, false);
      composer?.setSize(w, h);
      bloom?.resolution.set(w, h);
      camera.aspect = w / h;
      // keep the whole ring in frame on a tall, narrow stage
      camera.fov = w / h < 1 ? Math.min(58, 34 / Math.max(0.62, w / h)) : 34;
      camera.updateProjectionMatrix();
      // frame the ring: its half-width (~2.6) within 75 % of the view, its height (~2) within the view
      const t = Math.tan((camera.fov * Math.PI) / 360);
      dist0 = isHero ? Math.max(DIST, 3.47 / (t * camera.aspect)) : Math.min(DIST, Math.max(3.47 / (t * camera.aspect), 2.05 / t));
      if (!running) frame();
    },
    start() { if (running || disposed) return; running = true; clock.start(); raf = requestAnimationFrame(loop); },
    stop,
    frame,
    cull(x) { fieldU.uCullX.value = x; },
    stats: () => ({ fps: Math.round(fpsEma), level, spores: level >= 1 ? FULL >> 1 : FULL }),
    dispose() {
      disposed = true;
      stop();
      canvas.removeEventListener("webglcontextlost", onLost);
      rootU.uTex.value?.dispose();
      disposables.forEach((d) => d.dispose());
      kids.dispose();
      composer?.dispose();
      bloom?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
