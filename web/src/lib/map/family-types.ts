// Shared shapes of the family loader (DESIGN-FAMILY-ALL.md §3a). Verbatim from the doc; change it only through the doc.
import type { BubbleNode } from "./types";

/** One coin of GET /api/map/family/:mint, positional: [mint, symbol, mcapUsd, lockedUsd, createdAt (unix s), migrated, children]. */
export type FamilyRow = [string, string | null, number | null, number | null, number | null, 0 | 1, number];
/** GET /api/map/family/:mint?offset=&limit=&v= : the coins quoted in :mint (a listed asset or any tracked coin), biggest first. */
export type MapFamilyResponse = { mint: string; v: number; total: number; offset: number; next: number | null; nodes: FamilyRow[] };
/** Consecutive rows in server order, columnar. `from` = index of the first row in the family's full list; NaN = unknown. */
export type FamilyChunk = {
  top: string; from: number; n: number;
  mints: string[]; symbols: (string | null)[];
  mcapUsd: Float64Array; lockedUsd: Float64Array; createdAt: Float64Array; migrated: Uint8Array; children: Uint32Array;
};
export type FamilyState = "idle" | "loading" | "partial" | "done" | "error";
export type FamilyInfo = { top: string; total: number; loaded: number; cap: number; state: FamilyState; v: number | null; error: string | null };
export type FamilyWhy = "view" | "select" | "search" | "panel";
export type FamilyEvent =
  | { kind: "chunk"; top: string; chunk: FamilyChunk }
  | { kind: "evict"; top: string }
  | { kind: "state"; top: string; info: FamilyInfo };
export interface FamilyStore {
  /** Replaces the wanted list for `why` (most wanted first; [] clears it). Loads, cancels and evictions follow from the union. */
  want(tops: readonly string[], why: FamilyWhy): void;
  info(top: string): FamilyInfo | null;
  /** Every loaded chunk of `top`, in row order (drawn coins included: a consumer skips what it already draws). */
  chunks(top: string): readonly FamilyChunk[];
  /** A loaded coin as a map node (parentMint = top); the same object while it stays loaded; null when not loaded. */
  node(mint: string): BubbleNode | null;
  /** The loaded family holding `mint`, or null. */
  familyOf(mint: string): string | null;
  /** Loaded coins whose ticker matches `needle` (MapSearch's score rules), best first. */
  search(needle: string, max: number): BubbleNode[];
  /** True while any page request is in flight. */
  busy(): boolean;
  /** Bumps on every chunk, evict and state change. */
  version(): number;
  subscribe(fn: (e: FamilyEvent) => void): () => void;
  dispose(): void;
}
