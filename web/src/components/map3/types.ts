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
  /** Shows the on-map "size: locked | mcap" pill (.bm-size, top right, like the classic map's) and reports a click. */
  onModeChange?: (m: SizeMode) => void;
  inset: Map3Inset; fitInset: Map3Inset;
  select: string | null; onSelect: (n: BubbleNode | null) => void; onHover?: (mint: string | null) => void;
  fresh: Set<string>; highlight: ((n: BubbleNode) => boolean) | null; heat: HeatIndex | null; streamStatus: StreamStatus;
  onCamera: (c: { k: number }) => void;
  titleTags: ReadonlyMap<string, string> | null; titleTagsCompact: ReadonlyMap<string, string> | null;
  onFallback: (reason: FallbackReason, detail?: string) => void;
  /** The engine's look, fixed per page load: "galaxy" (the default) or "flat" (?look=flat, the 2.5D colony plate). */
  look?: "galaxy" | "flat";
  /** The family loader (lib/map/family.ts); null or absent = ghosts only. */ families?: FamilyStore | null;
  /** The Key's last-trade filter (lib/map/visibility.ts, `?last=`): bit k = draw the coins of heat class k (30 min, 3 h,
   * 24 h, older); 15 = all, the filter off. The page sends 15 until its heat has answered. (compact layout) A change of mask
   * rebuilds the map from the filtered set (buildSet: shown + lineage + pins; reason "last"), so each family is laid out
   * compactly around what is shown; between builds the engine hides in place (EngineHandle.setLastFilter) and a rebuild
   * starts with it (EngineOptions.last). */
  last: number;
  /** The mask the reader asked for, heat or not (Map.tsx lastWant): while it is not 15 the first build waits longer for the
   * heat, so it is built filtered once. Absent = `last`. */
  lastWant?: number;
  /** Mints always shown whatever their bucket: the selection and its ancestor chain (one array per selection). Never a
   * rebuild: a pinned coin the build left out is added live (EngineHandle.reveal). */
  pinned: readonly string[];
  ref?: Ref<BubbleMapHandle>;
};
