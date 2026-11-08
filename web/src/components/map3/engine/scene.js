// LOOK LANE (2026-10-21 16:00Z, owner item 3): galaxy overview = monolith fitTo(0, 0, Rout, 0.96) on desktop AND phone,
// k0 = 0.96 (min(w', h') / 2) / Rout, then lowered until every family top (dust included, with its radius + 6 px) is inside
// the fit rect; the 1.22 Rcl / 1.6 Rcl caps are gone under galaxy (flat keeps them). Rvis = RoutMax under galaxy.
// FINAL POLISH (2026-10-21): the desktop overview fits the cluster plus a narrow halo (1.22 Rcl), so the colonies fill the
// frame; the caption anchor sits just under the colonies.
// scene.js: renderer, THREE.Scene, orthographic camera, composer (RenderPass, UnrealBloom, OutputPass),
// the graphite background quad (vignette + dither), resize, and the overview fit (overviewTarget / k0).
// (map3 port) Changed from the prototype:
//   - the renderer draws on the canvas the engine created (S.layers.canvas) with the WebGL2 context index.js created and
//     checked (S.gl), so a missing context is an EngineError('webgl'), never a three console error. The canvas size
//     follows the container through CSS (100 %); resize() sets the drawing buffer (DPR capped at 2) and the bloom.
//   - context loss: webglcontextlost stops rendering and calls callbacks.onLost after 3 s; webglcontextrestored calls it
//     at once (the app rebuilds the engine or falls back).
//   - overviewTarget() fits inside S.fitRect() (the container minus the page's chrome bands) and maps the cluster centre to
//     that rect's centre: desktop k = (min(w', h') / 2 - 24) / (0.92 min(Rvis, 1.22 Rcl)); phone
//     k = min((w' - 16) / (2 rx), (h' - 16) / (2 ry)). No extra y offset.
//   - limeShare / hdrCheck go to S.debugFns; the mask material and quad are created inside hdrCheck and disposed after.
//   - dispose: composer, bloom, output pass, background, renderer.dispose() + forceContextLoss().
//
// EXPORTS
//   buildScene(S)   needs S.Rcl/S.Rout (call after placeDust). Fills S.gfx:
//     renderer, scene, camera, composer, bloom, render(), resize(), gpu, drawStats
//   and S.overview:
//     overviewTarget() -> {x, y, k}   the camera that frames the whole map; also refreshes S.overview.k0, S.U.uK0,
//                                     S.overview.Rvis (+ uRvis), S.dustTypR (hand-off never before 1.6 k0) and S.dustCaption
//     k0, Rvis, uRvis {value}
//
// Colour pipeline: NoToneMapping, linear HalfFloat targets, OutputPass encodes sRGB once. Only live core dots
// (x1.3/x1.6) and pulse heads (x1.4) may exceed 1.0 linear; bloom threshold is 1.0, so it can never wash
// the overview. Bloom resolution: UnrealBloomPass HALVES the size it is given internally, so it is fed the
// full drawing-buffer size and its bright pass runs at exactly half resolution.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { TOK, GAL } from "./tokens.js";

const srgb3 = (hex) => new THREE.Vector3(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);

export function buildScene(S) {
  const { W, H } = S;
  // (galaxy look, 2026-10-21) one engine, two looks: G = galaxy. T = S.tok (GAL over TOK) or TOK, so flat reads TOK values.
  const G = S.look === "galaxy", T = S.tok || TOK;
  const canvas = S.layers.canvas;
  const renderer = new THREE.WebGLRenderer({ canvas, context: S.gl, antialias: false, powerPreference: "high-performance", stencil: false });
  renderer.setPixelRatio(S.DPR); renderer.setSize(W(), H(), false);   // (map3 port) CSS sizes the canvas (100 %)
  renderer.toneMapping = THREE.NoToneMapping; renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(new THREE.Color(T.bg), 1);      // safety only: the background quad paints every pixel
  // ---------- teardown (registered right after the renderer exists, so it runs last; every step is guarded: a build that
  // failed half-way leaves later names in their temporal dead zone) ----------
  // A lost context took every GPU object with it: then no object is deleted (three would warn about objects of the old
  // context after a restore), but renderer.dispose() still runs: it drops three's canvas listeners and render lists, so
  // nothing on the canvas keeps the scene (and with it S) alive. The context is released unless it is lost right now.
  S.life.onDispose(() => {
    if (!S.contextLost) {
      try { scene.remove(bg); bgGeo.dispose(); bgMat.dispose(); } catch { /* ignore */ }
      try { bloom.dispose(); } catch { /* ignore */ }
      try { outputPass.dispose(); } catch { /* ignore */ }
      try { composer.dispose(); } catch { /* ignore */ }
    }
    let lostNow = true;
    try { lostNow = renderer.getContext().isContextLost(); } catch { /* ignore */ }
    try { renderer.dispose(); } catch { /* ignore */ }
    if (!lostNow) { try { renderer.forceContextLoss(); } catch { /* ignore */ } }
  });
  const scene = new THREE.Scene();                          // no scene.background (graphite comes from the quad)
  const camera = new THREE.OrthographicCamera(-W() / 2, W() / 2, H() / 2, -H() / 2, -100, 100);
  camera.position.set(0, 0, 50);

  // ---- background: one full-screen triangle, vignette #0E1211 -> #070908 + 1/255 dither, ~3 % luminance, no hue ----
  const bgGeo = new THREE.BufferGeometry();
  bgGeo.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const bgMat = new THREE.ShaderMaterial({
    uniforms: { uRes: { value: new THREE.Vector2(W() * S.DPR, H() * S.DPR) }, uC: { value: srgb3(T.vigC) }, uE: { value: srgb3(T.vigE) } },
    vertexShader: /* glsl */`void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */`
uniform vec2 uRes; uniform vec3 uC, uE;
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
// exact inverse of the sRGB OETF that OutputPass applies, so the dither survives the round trip
vec3 toLinear(vec3 c){ return mix(pow(c * 0.9478672986 + 0.0521327014, vec3(2.4)), c * 0.0773993808, vec3(lessThanEqual(c, vec3(0.04045)))); }
void main(){
  vec2 uv = vec2(gl_FragCoord.x / uRes.x, 1.0 - gl_FragCoord.y / uRes.y);     // CSS orientation (y down)
  float aspect = uRes.x / uRes.y;
  float rr = length((uv - vec2(0.5, 0.46)) * vec2(aspect, 1.0)) / length(vec2(0.5 * aspect, 0.54));
  vec3 c = mix(uC, uE, smoothstep(0.25, 1.05, rr));
  c += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(toLinear(max(c, vec3(0.0))), 1.0);
}`,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending,
  });
  const bg = new THREE.Mesh(bgGeo, bgMat); bg.frustumCulled = false; bg.renderOrder = -10; scene.add(bg);

  // ---- composer: RenderPass -> UnrealBloom (half res, hot cores only) -> OutputPass ----
  const composer = new EffectComposer(renderer);            // HalfFloat targets keep HDR
  composer.setPixelRatio(S.DPR); composer.setSize(W(), H());
  const renderPass = new RenderPass(scene, camera);
  // draw-call accounting (integration): three resets renderer.info on every render() call, so with autoReset
  // only the last pass (OutputPass) was ever counted. Reset once per composed frame instead and record the
  // scene's own draws (the RenderPass) apart from the post chain. S.gfx.drawStats = {scene, frame, tris}.
  const drawStats = { scene: 0, frame: 0, tris: 0 };
  { const rp = renderPass.render.bind(renderPass);
    renderPass.render = (...a) => { const c0 = renderer.info.render.calls, t0 = renderer.info.render.triangles; rp(...a); drawStats.scene = renderer.info.render.calls - c0; drawStats.tris = renderer.info.render.triangles - t0; }; }
  composer.addPass(renderPass);
  // (galaxy) bloom 0.72 / 0.42 / 0.85 (phone 0.60 / 0.42 / 0.85): the lit spheres, veins and coronas (HDR x heatK) glow; flat: TOK.bloom
  const B = G ? (S.phone() ? (T.bloomPhone || GAL.bloomPhone) : (T.bloom || GAL.bloom)) : TOK.bloom;
  const bloom = new UnrealBloomPass(new THREE.Vector2(W() * S.DPR, H() * S.DPR), B.strength, B.radius, B.threshold);
  // (integration) the two deepest mips add no visible spark, only a 1/255 square plateau ~50 px around every live chip: mute them.
  // (look lane 16:20Z, measured) galaxy mutes the two widest mips too: with 2,228 lit family tops + HDR veins every mip on
  // turned the overview into a green wash (lit 0.47 / lime 0.174 / meanLum 74 vs ref-overview 0.169 / 0.030 / 39.8);
  // mips 3-4 off + strength 0.40 measured lit 0.214 / lime 0.030 / meanLum 42.5 (LANES.md "look lane")
  for (const j of [3, 4]) bloom.bloomTintColors[j].set(0, 0, 0);
  S.debug.map.bloom = { strength: B.strength, radius: B.radius, threshold: B.threshold, look: G ? "galaxy" : "flat" };
  composer.addPass(bloom);
  const outputPass = new OutputPass();
  composer.addPass(outputPass);
  renderer.info.autoReset = false;

  // ---- overview fit (spec overview 6, adapted to the compact layout; map3 port: inside the fit rect) ----
  // The frame fits the VISIBLE field radius Rvis = min(Rout, VF*Rcl) (desktop: the cluster plus a narrow halo, 1.22 Rcl):
  // the colonies stay the subject and the field dissolves at the frame edge. Phone: the portrait packing's width AND
  // height. The dust hand-off never starts before 1.6 k0 (S.dustTypR capped at 3.75/k0).
  const VF = 1.6;
  const uRvis = { value: S.Rout };
  const overviewTarget = () => {
    const r = S.fitRect(), w = Math.max(1, r.x1 - r.x0), h = Math.max(1, r.y1 - r.y0), cxR = (r.x0 + r.x1) / 2, cyR = (r.y0 + r.y1) / 2;
    let k, Rvis;
    if (G) {
      // (look lane) monolith fitTo(0, 0, Rout, 0.96), then every family top inside the fit rect (6 CSS px margin)
      const R = Math.max(1e-3, S.Rout || S.Rcl || 1);
      k = 0.96 * (Math.min(w, h) / 2) / R;
      const hw = w / 2 - 6, hh = h / 2 - 6;
      for (const f of S.fams) {
        if (!f || !Number.isFinite(f.cx) || !Number.isFinite(f.cy)) continue;
        const rr = f.Rc > 0 && !f.planet ? Math.min(f.Rc, 0.02 * R) : 0;   // a dust top's own radius (planets: centre + label pad)
        const ex = Math.abs(f.cx) + rr, ey = Math.abs(f.cy) + rr;
        if (ex > 0 && hw > 0) k = Math.min(k, hw / ex);
        if (ey > 0 && hh > 0) k = Math.min(k, hh / ey);
      }
      Rvis = Math.max(S.RoutMax || 0, S.Rout || 0, S.Rcl || 0);
      // debug (primitives, read through __sporeMap.engine()): the fit and how many family tops (top coin centre) fall outside
      let out = 0, tops = 0;
      if (S.X && S.Y) for (const f of S.fams) { if (!f || !(f.top >= 0)) continue; tops++; const x = S.X[f.top] * k, y = S.Y[f.top] * k; if (Math.abs(x) > w / 2 || Math.abs(y) > h / 2) out++; }
      Object.assign(S.debug.map, { fitK0: +k.toFixed(5), fitK0Rout: +(0.96 * (Math.min(w, h) / 2) / R).toFixed(5), fitRcl: +(S.Rcl || 0).toFixed(2), fitRout: +(S.Rout || 0).toFixed(2), fitRoutMax: +(S.RoutMax || 0).toFixed(2), fitW: Math.round(w), fitH: Math.round(h), fitTops: tops, fitTopsOut: out });
    } else if (S.phone()) {
      const rx = S.packAspect > 1 && S.RclX > 0 ? S.RclX : S.Rcl, ry = S.packAspect > 1 && S.RclY > 0 ? S.RclY : S.Rcl;
      k = Math.min(Math.max(8, w - 16) / (2 * Math.max(rx, 1e-3)), Math.max(8, h - 16) / (2 * Math.max(ry, 1e-3)));
      Rvis = Math.min(S.RoutMax, Math.max(VF * S.Rcl, 0.5 * H() / k));
    } else {
      Rvis = Math.min(S.Rout, VF * S.Rcl);
      k = Math.max(Math.min(w, h) / 4, Math.min(w, h) / 2 - 24) / (0.92 * Math.max(1e-3, Math.min(Rvis, 1.22 * S.Rcl)));
    }
    if (!G && S.X && S.Y && S.fams) {
      // (flat fix 2026-10-21, owner item 3) k0 = min(the frame above, the largest k at which every family top sits inside the
      // fit rect). A PLANET top counts with its drawn radius (max(R k, TOK.chipR)) and a 6 CSS px margin.
      // (bubbles lane, look fix 2026-10-22) a dust-family top is a 1.2-2 px speck at the overview (dust.js; its 3-6 px disc only
      // fades in from 1.6 k0), so it counts with radius 0 and a 2 px margin: desktop k0 ~0.57 (was 0.54 with the disc floor and
      // the 6 px margin; the old frame fit gave 0.76, which cut the far families off).
      // (repair, look fix 2026-10-22) the phone too: the owner's rule is "far families never disappear", and 1,600 of the
      // 2,433 tops sat off-frame at the portrait packing fit (k0 0.50). The dust field is now an oval with the portrait
      // aspect (dust.js), so the all-tops rule lands at ~0.32 instead of 0.26; the planet chips are k-independent (TOK.chipR),
      // so the planets keep their size and only the spacing shrinks.
      const ph = S.phone(), hw = w / 2, hh = h / 2;
      const k1 = k; let out = 0, tops = 0;
      for (const f of S.fams) {
        const i = f ? f.top : -1; if (!(i >= 0)) continue;
        const x = Math.abs(S.X[i]), y = Math.abs(S.Y[i]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (f.planet) {
          const rw = S.R ? S.R[i] || 0 : 0, m = TOK.chipR(f.share || 0, S.maxShare || 1, ph), hw6 = hw - 6, hh6 = hh - 6;
          if (x + rw > 0 && hw6 > 0) k = Math.min(k, hw6 / (x + rw));
          if (y + rw > 0 && hh6 > 0) k = Math.min(k, hh6 / (y + rw));
          if (x > 0 && hw6 > m) k = Math.min(k, (hw6 - m) / x);
          if (y > 0 && hh6 > m) k = Math.min(k, (hh6 - m) / y);
        } else {
          if (x > 0 && hw > 2) k = Math.min(k, (hw - 2) / x);
          if (y > 0 && hh > 2) k = Math.min(k, (hh - 2) / y);
        }
      }
      for (const f of S.fams) { const i = f ? f.top : -1; if (!(i >= 0)) continue; tops++; if (Math.abs(S.X[i] * k) > w / 2 || Math.abs(S.Y[i] * k) > h / 2) out++; }
      Object.assign(S.debug.map, { fitK0: +k.toFixed(5), fitK0Frame: +k1.toFixed(5), fitW: Math.round(w), fitH: Math.round(h), fitTops: tops, fitTopsOut: out, fitDustRule: "all-tops", fitPhone: ph });
    }
    if (!(k > 0) || !Number.isFinite(k)) k = 1;
    S.overview.k0 = k; S.U.uK0.value = k;
    S.overview.Rvis = Rvis; uRvis.value = Rvis;
    S.dustTypR = Math.min(S.overview.dustRcMedian || S.dustTypR, 3.75 / k);
    S.debug.map.fitDustTypR = +S.dustTypR.toFixed(3);
    S.dustCaption.x = 0; S.dustCaption.y = -1.02 * S.Rcl;
    // the cluster centre (world 0, 0) sits at the fit rect's centre
    return { x: -(cxR - W() / 2) / k, y: (cyR - H() / 2) / k, k };
  };
  // (map3 port) S.measure() has re-read the container size and the DPR; renderer, composer (and with it the bloom, fed the
  // full drawing-buffer size) and the background follow
  const resize = () => {
    renderer.setPixelRatio(S.DPR); renderer.setSize(W(), H(), false);
    composer.setPixelRatio(S.DPR); composer.setSize(W(), H());
    bgMat.uniforms.uRes.value.set(W() * S.DPR, H() * S.DPR);
    overviewTarget();
  };

  let gpu = "?";
  try { const gl = renderer.getContext(); const ext = gl.getExtension("WEBGL_debug_renderer_info"); gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); } catch { /* ignore */ }

  // ---- context loss (map3 port): stop drawing; tell the app after the restore, or after 3 s without one ----
  let lostTimer = 0, lostFired = false;
  const fireLost = () => {
    if (lostFired || S.dead) return;
    lostFired = true; S.life.clearTimeout(lostTimer);
    try { S.callbacks.onLost && S.callbacks.onLost(); } catch (e) { console.warn("map3 onLost", e); }
  };
  S.life.on(canvas, "webglcontextlost", (e) => { e.preventDefault(); S.contextLost = true; if (!lostTimer) lostTimer = S.life.timeout(fireLost, 3000); });
  S.life.on(canvas, "webglcontextrestored", () => fireLost());

  const render = () => {
    if (S.contextLost || S.dead) return false;
    renderer.info.reset(); composer.render(); drawStats.frame = renderer.info.render.calls;
    return true;
  };
  // (final fix) the quality governor's last step turns the bloom pass off (the composer skips a disabled pass)
  const setBloom = (on) => { bloom.enabled = !!on; S.invalidate(); };
  Object.assign(S.gfx, { renderer, scene, camera, composer, bloom, gpu, render, drawStats, resize, setBloom });
  Object.assign(S.overview, { overviewTarget, uRvis });
  overviewTarget();
  Object.assign(S.debug.obj, { renderer, camera, scene, bg });

  // ---------- gates (debug) ----------
  // CIE76 dE in Lab (D65) from 8-bit sRGB
  const lab = (r, g, b) => {
    const L = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const R = L(r), G = L(g), Bb = L(b);
    const x = (0.4124 * R + 0.3576 * G + 0.1805 * Bb) / 0.95047, y = 0.2126 * R + 0.7152 * G + 0.0722 * Bb, z = (0.0193 * R + 0.1192 * G + 0.9505 * Bb) / 1.08883;
    const f = (t) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    const fx = f(x), fy = f(y), fz = f(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  };
  const LIME = lab(0xb6, 0xff, 0x5c), CORE = lab(0xe9, 0xff, 0xc9);
  const dE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  S.debugFns.limeShare = () => {
    if (S.contextLost) return 0;
    S.motion.applyCam(); composer.render();
    const gl = renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const buf = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const memo = new Map(); let n = 0, hit = 0, hitHue = 0; const galaxyLook = S.look === "galaxy";   // (integrator) galaxy: lime hue (HDR lime clips toward white after bloom)
    for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) {
      const o = (y * w + x) * 4, key = (buf[o] << 16) | (buf[o + 1] << 8) | buf[o + 2]; n++;
      let v = memo.get(key); if (v === undefined) { const c = lab(buf[o], buf[o + 1], buf[o + 2]); const strict = dE(c, LIME) <= 12 || dE(c, CORE) <= 12 ? 1 : 0; const r = buf[o] / 255, g = buf[o + 1] / 255, b = buf[o + 2] / 255; const hue = galaxyLook && g >= 0.55 && g >= r + 0.04 && b <= 0.72 * g ? 1 : 0; v = strict | (hue << 1); memo.set(key, v); }
      hit += v & 1; hitHue += v ? 1 : 0;
    }
    S.debugFns.limeShare.last = { samples: n, hits: hit, hitsAny: hitHue, strict: +(hit / n).toFixed(5), any: +(hitHue / n).toFixed(5), w, h, look: S.look };
    return galaxyLook ? +(hitHue / n).toFixed(5) : +(hit / n).toFixed(5);
  };

  // bloom input check: the scene alone into a HalfFloat target, a mask pass (max channel > 1.0) into RGBA8, read back.
  // (map3 port) the mask material and its quad live only for the duration of one check.
  S.debugFns.hdrCheck = () => {
    if (S.contextLost) return { ok: false, contextLost: true };
    S.motion.applyCam();
    const maskMat = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null } },
      vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */`uniform sampler2D tSrc; varying vec2 vUv;
void main(){ vec3 c = texture2D(tSrc, vUv).rgb; float m = max(c.r, max(c.g, c.b)); gl_FragColor = vec4(m > 1.002 ? 1.0 : 0.0, clamp((m - 1.0) / 2.0, 0.0, 1.0), 0.0, 1.0); }`,
      depthTest: false, depthWrite: false,
    });
    const fsq = new FullScreenQuad(maskMat);
    // hide(o) -> true hides that object for this pass
    const hdrMask = (hide) => {
      const gl = renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const opt = { type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false };
      const rt = new THREE.WebGLRenderTarget(w, h, opt), rt8 = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false });
      const hidden = []; if (hide) scene.traverse((o) => { if (o !== scene && o.visible && (o.isMesh || o.isPoints || o.isLine) && hide(o)) { o.visible = false; hidden.push(o); } });
      renderer.setRenderTarget(rt); renderer.clear(); renderer.render(scene, camera);
      for (const o of hidden) o.visible = true;
      maskMat.uniforms.tSrc.value = rt.texture; renderer.setRenderTarget(rt8); fsq.render(renderer);
      const buf = new Uint8Array(w * h * 4); renderer.readRenderTargetPixels(rt8, 0, 0, w, h, buf);
      renderer.setRenderTarget(null); rt.dispose(); rt8.dispose();
      return { buf, w, h, hidden: hidden.length };
    };
    try {
      const DPR = S.DPR;
      const all = hdrMask(null), noPulse = hdrMask((o) => o.renderOrder === 11);   // pulses render at renderOrder 11
      const { w, h } = all, k = S.cam.k;
      const fams = S.fams, famOf = S.famOf, age = S.age, R = S.R, X = S.X, Y = S.Y;
      // (galaxy) HDR is the design inside a family disc (lit spheres x heatK, veins, coronas): an offender is HDR OUTSIDE every
      // family disc (f.cx, f.cy, f.Rc in screen px, + 3 px slack for the dust speck's own size). Family discs go into a 48 px grid.
      let inDiscOf = null, famPx = 0;
      if (G) {
        const CELL = 48, cols = Math.ceil(w / DPR / CELL) + 1, rows = Math.ceil(h / DPR / CELL) + 1, cells = new Map();
        const put = (cx, cy, r) => { const x0 = Math.max(0, Math.floor((cx - r) / CELL)), x1 = Math.min(cols - 1, Math.floor((cx + r) / CELL)), y0 = Math.max(0, Math.floor((cy - r) / CELL)), y1 = Math.min(rows - 1, Math.floor((cy + r) / CELL)); for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) { const key = yy * cols + xx; let a = cells.get(key); if (!a) cells.set(key, (a = [])); a.push(cx, cy, r); } };
        // a planet's chip (TOK.chipR CSS px + its rim) can be wider than f.Rc * k for a small family: the disc is the larger of the two
        for (const f of fams) { if (!(f.Rc > 0)) continue; const sx = (f.cx - S.cam.x) * k + W() / 2, sy = H() / 2 - (f.cy - S.cam.y) * k, r = Math.max(f.Rc * k, f.planet ? TOK.chipR(f.share, S.maxShare, S.phone()) + 6 : 0) + 3 + (f.planet ? 0 : (GAL.dustDrift.amp0 + GAL.dustDrift.ampK * f.Rc) * k + 2); if (sx + r < 0 || sy + r < 0 || sx - r > W() || sy - r > H()) continue; put(sx, sy, r); }
        inDiscOf = (sx, sy) => { const a = cells.get(Math.floor(sy / CELL) * cols + Math.floor(sx / CELL)); if (!a) return false; for (let q = 0; q < a.length; q += 3) { const dx = sx - a[q], dy = sy - a[q + 1]; if (dx * dx + dy * dy <= a[q + 2] * a[q + 2]) return true; } return false; };
      }
      const liveAt = (i) => { const f = fams[famOf[i]]; return (i === f.top ? f.age : age[i]) <= 1800; };
      const chip = (i) => { const f = fams[famOf[i]]; return i === f.top && f.planet ? TOK.chipR(f.share, S.maxShare, S.phone()) : 0; };
      let hdrPx = 0, pulsePx = 0, liveCorePx = 0, offenders = 0; const samples = [];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4; if (all.buf[o] < 128) continue;
        hdrPx++;
        if (noPulse.buf[o] < 128) { pulsePx++; continue; }
        const sx = (x + 0.5) / DPR, sy = H() - (y + 0.5) / DPR, [wx, wy] = S.toW(sx, sy), reach = 24 / k;
        let ok = false, near = -1, nd = Infinity;
        if (inDiscOf && inDiscOf(sx, sy)) { famPx++; continue; }
        if (S.worldGrid) S.worldGrid.forEachIn(wx - reach, wy - reach, wx + reach, wy + reach, (i) => {
          if (ok) return;
          const dpx = Math.hypot(X[i] - wx, Y[i] - wy) * k, rpx = Math.max(R[i] * k, chip(i), 1.5);
          if (dpx < nd) { nd = dpx; near = i; }
          if (dpx <= rpx + 2 && liveAt(i)) ok = true;
        });
        if (ok) { liveCorePx++; continue; }
        offenders++;
        if (samples.length < 12) samples.push({ sx: Math.round(sx), sy: Math.round(sy), max: +(1 + 2 * noPulse.buf[o + 1] / 255).toFixed(2), near: near >= 0 ? S.sym[near] : null, nearPx: Math.round(nd) });
      }
      // which layer emits it: each renderOrder group rendered alone (bg stays), px > 1.0 per group
      const byLayer = {};
      if (hdrPx) {
        const orders = new Set(); scene.traverse((o) => { if (o.isMesh || o.isPoints || o.isLine) orders.add(o.renderOrder); });
        for (const ro of orders) { if (ro === -10) continue; const m = hdrMask((o) => o.renderOrder !== ro && o.renderOrder !== -10); let c = 0; for (let i = 0; i < m.buf.length; i += 4) if (m.buf[i] >= 128) c++; byLayer[ro] = c; }
      }
      return { hdrPx, liveCorePx, pulsePx, offenders, samples, byLayer, ok: offenders === 0, w, h, look: G ? "galaxy" : "flat", famPx };
    } finally { fsq.dispose(); maskMat.dispose(); S.invalidate(); }
  };

  // (galaxy) vein share: the links mesh ALONE (no bubbles, glows, dust, ambient, nebula, gen arcs, orbits, background; bloom
  // off) rendered straight to the canvas over black, then the share of pixels inside the focused family's screen disc
  // (uFocusFam >= 0, else the hovered family, else the largest planet; radius f.Rc * k) whose max channel is >= 64/255.
  // Works under both looks (flat gives the hairline share). Restores every visibility flag + bloom and invalidates.
  S.debugFns.veinShare = (key) => {
    if (S.contextLost) return { share: 0, px: 0, lit: 0, contextLost: true };
    S.motion.applyCam();
    const linksMesh = S.links && S.links.mesh;
    // (integrator) family pick: an explicit key, else the focused family, else the hovered one, else the family whose disc holds
    // the camera centre (zoomTo/snap cameras do not set uFocusFam), else the largest planet.
    const byKey = key != null ? (S.famBy ? S.famBy(String(key).replace(/^\$+/, "")) : null) : null;
    const atCentre = () => { let best = -1, bs = Infinity; for (const f of S.fams || []) { if (!f || !(f.Rc > 0)) continue; const d = Math.hypot(f.cx - S.cam.x, f.cy - S.cam.y); if (d <= f.Rc + 1e-6 && d / f.Rc < bs) { bs = d / f.Rc; best = f.id; } } return best; };
    const fi = byKey ? byKey.id : S.U.uFocusFam.value >= 0 ? S.U.uFocusFam.value : S.U.uHoverFam.value >= 0 ? S.U.uHoverFam.value : (() => { const c = atCentre(); return c >= 0 ? c : (S.planets[0] ? S.planets[0].id : -1); })();
    const f = fi >= 0 ? S.fams[fi] : null;
    if (!f || !linksMesh) return { share: 0, px: 0, lit: 0, fam: fi };
    const hidden = [];
    scene.traverse((o) => { if (o !== scene && o.visible && (o.isMesh || o.isPoints || o.isLine) && o !== linksMesh) { o.visible = false; hidden.push(o); } });
    const bloomWas = bloom.enabled, clearWas = new THREE.Color(); renderer.getClearColor(clearWas);
    const gl = renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const buf = new Uint8Array(w * h * 4);
    try {
      bloom.enabled = false; renderer.setClearColor(0x000000, 1);
      renderer.setRenderTarget(null); renderer.clear(); renderer.render(scene, camera);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    } finally {
      for (const o of hidden) o.visible = true;
      bloom.enabled = bloomWas; renderer.setClearColor(clearWas, 1); S.invalidate();
    }
    const DPR = S.DPR, k = S.cam.k;
    const cx = ((f.cx - S.cam.x) * k + W() / 2) * DPR, cy = (H() / 2 - (f.cy - S.cam.y) * k) * DPR, r = f.Rc * k * DPR;   // device px, y down
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r)), y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
    let px = 0, lit = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy; if (dx * dx + dy * dy > r * r) continue;
      px++;
      const o = ((h - 1 - y) * w + x) * 4;   // readPixels rows run bottom-up
      if (buf[o] >= 64 || buf[o + 1] >= 64 || buf[o + 2] >= 64) lit++;
    }
    return { share: px ? +(lit / px).toFixed(4) : 0, px, lit, fam: f.id, sym: S.sym[f.top], rPx: Math.round(r / DPR), look: G ? "galaxy" : "flat" };
  };

}
