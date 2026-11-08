// GLSL for the colony (DESIGN-ELEVATE §7). Plain strings so the scene module stays free of loaders.
// Every fragment shader ends in <colorspace_fragment>: linear while rendering into the bloom chain,
// sRGB when the phone path draws straight to the canvas.

/** Cheap 3D value noise shared by the root's inner gradient. */
const NOISE = /* glsl */ `
float h31(vec3 p) { p = fract(p * .3183099 + .1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z);
}`;

/** The root: fresnel rim in lime, a slow teal → lime inner gradient, the logo on the facing side, 0.5 % breathing. */
export const ROOT_VERT = /* glsl */ `
uniform float uTime;
varying vec3 vN; varying vec3 vV; varying vec3 vObj;
void main() {
  vObj = position;
  float breath = 1.0 + 0.005 * sin(uTime * 1.3 + position.y * 2.0);
  vec4 mv = modelViewMatrix * vec4(position * breath, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

export const ROOT_FRAG = /* glsl */ `
uniform float uTime; uniform sampler2D uTex; uniform float uHasTex; uniform float uPulse; uniform float uHover;
uniform vec3 uLime; uniform vec3 uTeal; uniform vec3 uDeep;
varying vec3 vN; varying vec3 vV; varying vec3 vObj;
${NOISE}
void main() {
  float ndv = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
  float fres = pow(1.0 - ndv, 2.6);
  float n = vnoise(vObj * 2.2 + vec3(0.0, uTime * 0.12, uTime * 0.05)) * 0.6 + vnoise(vObj * 5.0 - uTime * 0.08) * 0.4;
  vec3 inner = mix(uDeep, mix(uTeal, uLime, smoothstep(.35, .85, n)) * 0.42, 0.55 + 0.45 * n);
  vec3 col = inner;
  // the logo, projected on the hemisphere that faces the camera, kept soft at its edge
  vec2 uv = vObj.xy * 0.62 + 0.5;
  float face = smoothstep(0.15, 0.75, vObj.z) * (1.0 - smoothstep(0.42, 0.5, length(uv - 0.5)));
  if (uHasTex > 0.5) {
    vec4 tex = texture2D(uTex, vec2(uv.x, uv.y));
    col = mix(col, tex.rgb * 0.6, face * tex.a * 0.92);
  }
  col += uLime * fres * (1.05 + 0.6 * uPulse + 0.35 * uHover);
  col += uLime * 0.08 * uPulse;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

/**
 * The children: one instanced draw. A dark glass bead with a teal fresnel rim, the coin's logo held on
 * the side that faces the camera (a 4 × 3 atlas, tile aTile, -1 when it has none); aGlow brightens a
 * hovered or newborn one.
 */
export const KID_VERT = /* glsl */ `
attribute float aGlow; attribute float aTile;
varying vec3 vN; varying vec3 vV; varying float vGlow; varying vec2 vUv; varying float vTile;
void main() {
  vec4 c = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  float sc = max(length(instanceMatrix[0].xyz), 1e-4);
  vUv = (mv.xy - c.xy) / sc * 0.55 + 0.5;
  vN = normalize(normalMatrix * mat3(instanceMatrix) * normal);
  vV = normalize(-mv.xyz);
  vGlow = aGlow; vTile = aTile;
  gl_Position = projectionMatrix * mv;
}`;

export const KID_FRAG = /* glsl */ `
uniform vec3 uTeal; uniform vec3 uLime; uniform vec3 uDeep; uniform sampler2D uAtlas;
varying vec3 vN; varying vec3 vV; varying float vGlow; varying vec2 vUv; varying float vTile;
void main() {
  float ndv = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
  float fres = pow(1.0 - ndv, 3.2);
  float edge = smoothstep(0.3, 0.02, ndv);
  vec3 rim = mix(uTeal, uLime, vGlow * 0.7);
  vec3 col = uDeep * 1.2 + uTeal * 0.06 * pow(ndv, 2.0);
  float rimK = 1.0;
  if (vTile > -0.5) {
    float row = floor(vTile / 4.0), cl = vTile - row * 4.0;
    vec2 uv = clamp(vUv, 0.0, 1.0);
    vec4 t = texture2D(uAtlas, vec2((cl + uv.x) / 4.0, 1.0 - (row + 1.0 - uv.y) / 3.0));
    // the logo in its own colours (a coin face under glass), kept just under the bloom threshold so its
    // art stays crisp; a hovered or newborn child lets it glow
    float face = smoothstep(0.05, 0.3, ndv) * (1.0 - smoothstep(0.455, 0.5, length(vUv - 0.5)));
    float m = face * t.a;
    col = mix(col, t.rgb * (0.54 + 0.3 * vGlow), m * 0.97);
    rimK = 1.0 - 0.55 * m;
  }
  col += rim * (fres * 0.9 + edge * 0.45) * (1.0 + 1.3 * vGlow) * rimK;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

/**
 * The filaments: one merged geometry of canonical tubes (aT along the length, aAng around it, aKid the
 * child). The vertex shader bends each one from the root's rim to its child's live position, so a morph or a
 * bud needs no new geometry. A faint light runs down each tube toward the root (buys flow up).
 */
export const FIL_VERT = /* glsl */ `
uniform vec4 uKid[12]; uniform float uGrow[12]; uniform float uTime; uniform float uWidth; uniform vec3 uView; uniform float uRootR;
attribute float aT; attribute float aAng; attribute float aKid;
varying float vT; varying float vGrow; varying float vFlow;
vec3 bez(vec3 a, vec3 b, vec3 c, float t) { float u = 1.0 - t; return u * u * a + 2.0 * u * t * b + t * t * c; }
void main() {
  int k = int(aKid + 0.5);
  vec3 end = uKid[k].xyz;
  float g = uGrow[k];
  float t = aT * g;
  // it leaves the root just outside the silhouette the camera sees, on the child's side, so it is never
  // drawn across the root's face (colony.ts filStart is the same point)
  vec3 sd = end - dot(end, uView) * uView;
  float sl = length(sd);
  vec3 a0 = sl > 1e-4 ? sd * (uRootR / sl) : vec3(0.0, -uRootR, 0.0);
  vec3 dv = end - a0; float L = length(dv);
  vec3 mid = a0 + dv * 0.5 + vec3(0.0, 0.07 * L, 0.0) + vec3(-dv.z, 0.0, dv.x) / max(length(dv.xz), 1e-4) * L * 0.08;
  vec3 p = bez(a0, mid, end, t);
  vec3 tan = normalize(bez(a0, mid, end, min(t + 0.01, 1.0)) - bez(a0, mid, end, max(t - 0.01, 0.0)) + 1e-5);
  vec3 nrm = normalize(cross(tan, vec3(0.0, 1.0, 0.0)) + 1e-4);
  vec3 bin = cross(tan, nrm);
  float r = mix(0.022, 0.009, aT) * uWidth * step(0.001, g);
  p += (nrm * cos(aAng) + bin * sin(aAng)) * r;
  vT = aT; vGrow = g;
  // the flow: a soft band travelling from the child (t = 1) to the root (t = 0), staggered per child
  float ph = fract(uTime * 0.16 + aKid * 0.137);
  vFlow = exp(-pow((aT - (1.0 - ph)) * 7.0, 2.0));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

export const FIL_FRAG = /* glsl */ `
uniform vec3 uLime; uniform vec3 uTeal;
varying float vT; varying float vGrow; varying float vFlow;
void main() {
  vec3 col = mix(uLime, uTeal, smoothstep(0.0, 0.85, vT));
  // grows out of the root's rim light: a short fade where it leaves the root
  float a = mix(0.8, 0.28, vT) * smoothstep(0.0, 0.05, vGrow) * smoothstep(0.0, 0.12, vT);
  gl_FragColor = vec4(col * (a + vFlow * 0.9), 1.0);
  #include <colorspace_fragment>
}`;

/** Round, soft sprites: grandchildren, trade motes. aColor per point, aSize in px at depth 1. */
export const DOT_VERT = /* glsl */ `
uniform float uPx;
attribute vec3 aColor; attribute float aSize;
varying vec3 vCol;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vCol = aColor;
  gl_PointSize = aSize * uPx / max(0.5, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

export const DOT_FRAG = /* glsl */ `
varying vec3 vCol;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  float core = smoothstep(0.22, 0.0, d);
  gl_FragColor = vec4(vCol * (a * a * 0.9 + core * 0.9), 1.0);
  #include <colorspace_fragment>
}`;

/**
 * The spore field: thousands of soft discs drifting up on a slow curl-like path, twinkling, smaller and
 * dimmer with depth. Left of uCullX (clip space) only one point in five survives, so the headline
 * keeps a quiet background.
 */
export const FIELD_VERT = /* glsl */ `
uniform float uTime; uniform float uPx; uniform float uCullX;
uniform vec3 uLime; uniform vec3 uTeal; uniform vec3 uViolet;
attribute vec4 aSeed;
varying vec3 vCol; varying float vA;
void main() {
  vec3 p = position;
  float t = uTime;
  float span = 10.0;
  p.y = mod(p.y + 5.0 + t * (0.035 + aSeed.y * 0.06), span) - 5.0;
  p.x += sin(t * 0.07 + aSeed.x * 6.2831 + p.y * 0.35) * 0.35;
  p.z += cos(t * 0.05 + aSeed.y * 6.2831 + p.x * 0.30) * 0.30;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float size = (0.6 + aSeed.w * 1.8) * uPx / max(0.5, -mv.z);
  if (gl_Position.x / gl_Position.w < uCullX && aSeed.x > 0.2) size = 0.0;
  gl_PointSize = size;
  float tw = 0.62 + 0.38 * sin(t * (0.5 + aSeed.y * 1.5) + aSeed.x * 40.0);
  float edge = smoothstep(-5.0, -4.0, p.y) * (1.0 - smoothstep(4.0, 5.0, p.y));
  float depth = smoothstep(-22.0, -5.0, mv.z);
  vA = (0.22 + 0.6 * aSeed.z) * tw * edge * (0.35 + 0.65 * depth);
  vCol = aSeed.y < 0.58 ? mix(uLime, vec3(1.0), 0.25) : aSeed.y < 0.86 ? uTeal : uViolet;
}`;

export const FIELD_FRAG = /* glsl */ `
varying vec3 vCol; varying float vA;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.05, d);
  gl_FragColor = vec4(vCol * a * a * vA, 1.0);
  #include <colorspace_fragment>
}`;
