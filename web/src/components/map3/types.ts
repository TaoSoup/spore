import type { Ref } from "react";
import type { BubbleNode, RootsLimit, SizeMode } from "../../lib/map/types";
import type { HeatIndex } from "../../lib/map/heat";
import type { StreamStatus } from "../../lib/events";
import type { MapSource } from "../../lib/map/use-map-data";
import type { BubbleMapHandle } from "../BubbleMap";
import type { FamilyStore } from "../../lib/map/family-types";
export type Map3Inset = { left?: number; top?: number; right?: number; bottom?: number };
/// Why /map draws the classic renderer: ?renderer=classic, no WebGL2, the chunk failed to load, WebGL failed in the engine,
/// the engine failed to mount (or threw: MapBoundary), the context was lost for good, the kill switch (guard.tsx), or a
/// recent failure on this device for this build (guard.tsx).
export type FallbackReason = "param" | "no-webgl2" | "chunk-load" | "webgl" | "mount-error" | "context-lost" | "off" | "sticky";
export type ThreeMapHandle = BubbleMapHandle & { readonly renderer: "three"; chipRadius(share: number): number; maxShare(): number };
export type ThreeMapProps = {
  nodes: BubbleNode[]; byMint: ReadonlyMap<string, BubbleNode>; limit: RootsLimit; source: MapSource;
  mode: SizeMode;
  inset: Map3Inset; fitInset: Map3Inset;
  select: string | null; onSelect: (n: BubbleNode | null) => void; onHover?: (mint: string | null) => void;
  fresh: Set<string>; highlight: ((n: BubbleNode) => boolean) | null; heat: HeatIndex | null; streamStatus: StreamStatus;
  onCamera: (c: { k: number }) => void;
  titleTags: ReadonlyMap<string, string> | null; titleTagsCompact: ReadonlyMap<string, string> | null;
  onFallback: (reason: FallbackReason, detail?: string) => void;
  /** The engine's look, fixed per page load: "galaxy" (the default) or "flat" (?look=flat, the 2.5D colony plate). */
  look?: "galaxy" | "flat";
  /** The family loader (lib/map/family.ts); null or absent = ghosts only. */ families?: FamilyStore | null;
  ref?: Ref<BubbleMapHandle>;
};
