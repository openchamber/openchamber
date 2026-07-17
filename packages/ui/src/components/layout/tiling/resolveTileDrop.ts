import type { SplitAnchor } from "./splitTree"

// Normalized drop target derived from a dnd-kit `over` (its data.current). Kept
// dnd-kit-free so the drop-decision mapper is pure and unit-testable.
export type TileDropTarget =
  | { kind: "anchor"; groupId: string; anchor: SplitAnchor }
  | { kind: "strip"; groupId: string }
  | { kind: "tab"; groupId: string; tileId: string; index: number }

export type TileDropResult =
  | { kind: "split"; groupId: string; anchor: SplitAnchor }
  | { kind: "move"; groupId: string; index?: number }
  | { kind: "reorder"; groupId: string; overTileId: string }
  | null

export type ResolveTileDropInput = {
  activeTileId: string
  activeGroupId: string
  over: TileDropTarget | null
}

// Maps where a header-drag ended to which split-tree op should run. Place-on-drop
// only: never called mid-drag, so no live tree mutation (avoids the oscillation
// scar). splitLeaf itself guards single-tile-source no-ops, so a same-group
// anchor drop is safe to return as a split.
export const resolveTileDrop = ({ activeTileId, activeGroupId, over }: ResolveTileDropInput): TileDropResult => {
  if (!over) return null
  switch (over.kind) {
    case "anchor":
      return { kind: "split", groupId: over.groupId, anchor: over.anchor }
    case "strip":
      return over.groupId === activeGroupId ? null : { kind: "move", groupId: over.groupId }
    case "tab":
      if (over.tileId === activeTileId) return null
      return over.groupId === activeGroupId
        ? { kind: "reorder", groupId: over.groupId, overTileId: over.tileId }
        : { kind: "move", groupId: over.groupId, index: over.index }
  }
}
