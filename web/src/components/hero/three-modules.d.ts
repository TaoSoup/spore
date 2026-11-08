// three.js ships without TypeScript types in this project (no @types/three; the map engine is plain JS
// with its own index.d.ts). The colony scene is typed at its own boundary (colony.ts exports), so the
// library itself is declared loosely here.
declare module "three";
declare module "three/addons/postprocessing/EffectComposer.js";
declare module "three/addons/postprocessing/RenderPass.js";
declare module "three/addons/postprocessing/UnrealBloomPass.js";
declare module "three/addons/postprocessing/OutputPass.js";
