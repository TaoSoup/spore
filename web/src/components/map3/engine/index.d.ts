// The only typed surface of the JS engine (map3 spec section 3). skipLibCheck is on, so keep this file correct by hand.
export type EngineCoin = { mint: string; symbol: string | null; name: string | null; image: string | null; mcapUsd: number | null; lockedUsd: number | null; createdAt?: number | null; parentMint?: string | null;
  /** A listed quote asset drawn as a family top (counts 0 in the mcap family value); the server's liquidity cap of mcapUsd. */
  asset?: boolean; mcapCapUsd?: number | null;
  /** (family-all) A listed-asset top's TRUE child count (the server draws a capped slice); data.js f.ghost = children - drawn kids. */
  children?: number };
export type EngineTree = { coin: EngineCoin; children: EngineTree[] };
/** /api/map/heat wire shape: parallel arrays, unix seconds. */
export type EngineHeat = { at: number; mint: string[]; last: number[]; n24: number[]; t1h: number[]; v24: number[]; buys1h: number[] };
export type EngineTrade = { mint: string; time: number; isBuy: boolean; valueUsd?: number | null };
export type EnginePair = { coin: EngineCoin; parent: EngineCoin | null };
export type EngineEvent = { name: "trade"; data: EngineTrade } | { name: "pair"; data: EnginePair };
export type EngineInset = { left?: number; top?: number; right?: number; bottom?: number };
/** Container-relative CSS px. */
export type EngineRect = { x0: number; y0: number; x1: number; y1: number };
export type EngineImage = HTMLCanvasElement | ImageBitmap | HTMLImageElement;
export type EngineImages = { want(url: string, px: number): EngineImage | null; onLoaded(cb: () => void): () => void; ready(url: string): boolean;
  /** The loader failed this source for now (404, dead sheet cell, decode failure, its retries used up): the engine stops
   * asking and draws the monogram. */
  failed?(url: string): boolean;
  /** When a failed source takes a want again (Date.now() ms; 0 = now, Infinity = not on this page). The engine asks again
   * then, if the coin is drawn; without it a failure is for good. */
  retryAt?(url: string): number };
export type EngineCallbacks = { onSelect(mint: string | null): void; onHover(mint: string | null): void; onCamera(c: { k: number }): void; onFirstFrame(): void; onLost(): void;
  /** Galaxy: coins the viewer dragged, at each rope commit (world units; a top: its offset from the designed layout, any other
   * coin: its offset relative to its parent's). The shell merges them and passes them back as EngineOptions.moved. */
  onMoved?: (e: { mint: string; dx: number; dy: number }[]) => void;
  /** (family-all) The ghosted families the page should load (most screen area first; the focused family always), on every change. */
  onSwarmWant?: (tops: string[]) => void };
export type EngineMoved = ReadonlyMap<string, { dx: number; dy: number }>;
export type EngineOptions = {
  /** valueOf: a coin's part of its family's value in `mode` (f.value / f.share, the chip size). values: both modes' functions;
   * families are ranked by min(rank in locked, rank in mcap), so the planet set and the family order are the same in both
   * modes (absent: the same rules built in, lockedUsd and asset ? 0 : mcapCapUsd ?? mcapUsd). */
  roots: EngineTree[]; heat: EngineHeat | null; valueOf: (c: EngineCoin) => number; mode: "locked" | "mcap";
  values?: { locked: (c: EngineCoin) => number; mcap: (c: EngineCoin) => number };
  /** The previous engine's family order (top mints, EngineHandle.familyOrder) on a mode switch: kept as is, so the planet set and
   * the order do not move with prices that ticked between the two builds; families it does not list follow in the computed order. */
  order?: readonly string[];
  tagOf: (topMint: string) => string | null; nPlanets?: number;
  /** The look, fixed per mount: "galaxy" (the default: lit spheres, glowing veins, bloom) or "flat" (the 2.5D colony plate). */
  look?: "galaxy" | "flat";
  inset: EngineInset; fitInset: EngineInset; obstacles: EngineRect[];
  reducedMotion: boolean; feed: "up" | "down"; images: EngineImages;
  select: string | null; focusFamily: string | null; callbacks: EngineCallbacks;
  debug: boolean; signal: AbortSignal; failForTest?: boolean;
  /** Galaxy: the dragged positions to keep across rebuilds (the onMoved entries merged by mint); absent = the designed layout. */
  moved?: EngineMoved;
  /** (family-all) false = no swarm layer at all (the ?swarm=0 A/B switch); absent = on. */
  swarm?: boolean;
};
/** A page of a capped family's coins: the same shape as lib/map/family-types FamilyChunk. */
export type EngineSwarmChunk = { top: string; from: number; n: number; mints: string[]; symbols: (string | null)[]; mcapUsd: Float64Array; lockedUsd: Float64Array; createdAt: Float64Array; migrated: Uint8Array; children: Uint32Array };
export type EngineSwarmFamily = { top: string; ghost: number; slots: number; real: number; cap: number };
export type EngineSwarmStats = { tier: "desktop" | "phone" | "software"; families: number; slots: number; ghostVisible: number; real: number; queued: number; genMs: number; genSliceMaxMs: number; addSliceMaxMs: number; overlaps: number; drops: number; byFamily: EngineSwarmFamily[] };
export type EngineStat = { n: number; avg: number; p95: number; max: number };
export type EngineFrameStats = { frames: number; settling: EngineStat; settled: EngineStat; labels: number; drawn: number };
export type EngineFamilyInfo = { top: number; count: number; /** (family-all) the true family size: drawn members + ghost */ size: number; value: number; share: number; rank: number; planet: boolean; cx: number; cy: number; Rc: number; title: string };
export type EngineDebug = {
  coins(): number; built(): number; indexOf(mint: string): number; mintAt(i: number): string | null;
  world(i: number): { x: number; y: number; r: number } | null;
  screen(i: number): { x: number; y: number; r: number } | null;
  familyScreen(i: number): { x: number; y: number; r: number } | null;
  zoomTo(i: number, kRel: number): void; flying(): boolean; settled(): boolean;
  selected(): number; hovered(): number; hoverTop(): number;
  children(i: number): number[]; members(i: number): number[]; topOf(i: number): number; families(n: number): EngineFamilyInfo[];
  pick(cx: number, cy: number): { i: number; top: number; via: "coin" | "chip" | "speck" | "dust" | "colony" | "none" };
  lastTrade(i: number): number; t1h(i: number): number; fx(): number;
  titles(): number[]; taggedTitles(): number[]; labelCount(): number; drawnCount(): number; logoPx(i: number): number;
  hlBit(i: number): number; testHighlight(test: ((i: number) => boolean) | null): number;
  allXY(): { n: number; x: Float32Array; y: Float32Array };
  drag(): { i: number; top: number; rigid: boolean } | null;
  renders(): number; resetFrames(): void; sim(): { ticks: number; tickMs: number; alpha: number; active: boolean };
  build(): Record<string, number | string | boolean>;
  gl(): { geometries: number; textures: number; programs: number; contextLost: boolean };
  tip(): { on: boolean; i: number; dock: boolean; text: string };
  measure(ms: number, mode: "idle" | "pan" | "zoom" | "hover"): Promise<{ mode: string; frames: number; renders: number; fps: number; p50: number; p95: number; max: number }>;
  dragCoin(key: number | string, dx?: number, dy?: number, ms?: number, opts?: { hold?: number }): Promise<Record<string, unknown> | null>;
  feed(e: EngineEvent): Record<string, unknown>;
  live(): Record<string, unknown>; motion(): Record<string, unknown>; labels(): Record<string, unknown>;
  overlapCheck(): Record<string, unknown>; dustCheck(): Record<string, unknown>;
  limeShare(): number; hdrCheck(): Record<string, unknown>; linkMaxPx(): number;
  /** Galaxy: the share of the focused family's screen disc covered by lit vein pixels (null while the engine has no such probe). */
  veinShare(): { share: number; px: number; lit: number } | null;
  hover(key: number | string | null): Record<string, unknown> | null;
  focusFamily(key: string): Promise<Record<string, unknown> | null>;
  /** Any S.debugFns function by name (null when absent): coverage, logoCoverage, rope, home, moved, veinPath, focusState ... */
  call(name: string, ...a: unknown[]): unknown;
  /** The focus pulse: the coin, its uniforms (t, dim), its drawn radius (CSS px), the zoom and whether its pinned label is on. */
  focusState(): { i: number; t: number; dim: number; rPx: number; k: number; label: boolean } | null;
  /** (family-all) the swarm layer: tier, slots, ghosts shown, real specks, queue and slice timings. */
  swarm(): EngineSwarmStats;
};
export type EngineHandle = {
  fit(): void; flyToFamily(mint: string): boolean; flyToCoin(mint: string): boolean;
  zoomBy(factor: number): void; panBy(dx: number, dy: number): void;
  select(mint: string | null, opts?: { fly?: boolean }): boolean; selected(): string | null;
  hover(mint: string | null): void; setHighlight(test: ((mint: string) => boolean) | null): void;
  setHeat(heat: EngineHeat): void; applyEvent(e: EngineEvent): void;
  /** Market caps (tooltip and callout numbers); an entry with `image` also sets that coin's logo URL (patchImages). */
  patchCoins(p: readonly { mint: string; mcapUsd: number | null; image?: string | null }[]): void;
  /** Logo URLs that changed after the build (null = none): the coin forgets its old logo state and asks for the new one
   * (at once when it owns an atlas cell, else when it is next drawn at the logo size). Newborns included. Returns how many
   * coins took a new URL (unchanged ones and coins the engine does not draw are skipped). */
  patchImages(p: readonly { mint: string; image: string | null }[]): number;
  setTags(tagOf: (topMint: string) => string | null): void;
  setInset(inset: EngineInset, fitInset: EngineInset, obstacles: EngineRect[]): void;
  setReducedMotion(on: boolean): void; setFeed(state: "up" | "down"): void; resize(): void;
  knows(mint: string): boolean; topOf(mint: string): string | null;
  /** (family-all) Queues a page of a capped family's coins (slot j = the j-th undrawn coin in server order); returns the rows queued (0: no such ghosted family). */
  swarmAdd(chunk: EngineSwarmChunk): number;
  /** (family-all) Reverts a family's real specks to ghosts (the store evicted it). */
  swarmDrop(top: string): void;
  /** (family-all) The ghosted families of this engine (the page replays their loaded chunks after every rebuild). */
  swarmFamilies(): EngineSwarmFamily[];
  focusedFamily(): string | null; familyOrder(): string[];
  camera(): { x: number; y: number; k: number; k0: number }; zoom(): number;
  worldRadius(mcapUsd: number): number; chipRadius(share: number): number; maxShare(): number;
  frameStats(): EngineFrameStats;
  readonly debug: EngineDebug | null;
  destroy(): void;
};
export declare class EngineError extends Error {
  readonly code: "webgl" | "aborted" | "empty" | "build";
  constructor(code: "webgl" | "aborted" | "empty" | "build", message?: string, options?: { cause?: unknown });
}
export declare function mountEngine(container: HTMLDivElement, opts: EngineOptions): Promise<EngineHandle>;
export declare function engineCounters(): { live: number; created: number; destroyed: number };
