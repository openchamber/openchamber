/**
 * The phone list's tree geometry: the desktop file tree's, 12px per level, a
 * 14px chevron slot and a 6px gap before the text. Rows start near the edge,
 * as the desktop's do: a work is a row of its own, not a node under its
 * project, so the old 32px inset under the project tile only cost width. A
 * two-line row carries no slot, so its text starts 12px in; a one-line row's
 * slot sits there and its text 20px further.
 */
export type MobileTreeGeometry = {
  /** Where a level 0 row's slot starts; the tree guides take it too. */
  base: number;
  slotLeft: (depth: number) => number;
  textLeft: (depth: number) => number;
  /** Where a two-line row's text starts. */
  detailedLeft: (depth: number) => number;
};

const MOBILE_TREE_LEVEL_PX = 12;

const MOBILE_TREE_BASE_PX = 8;

const slotLeft = (depth: number): number => MOBILE_TREE_BASE_PX + depth * MOBILE_TREE_LEVEL_PX;

export const MOBILE_TREE_GEOMETRY: MobileTreeGeometry = {
  base: MOBILE_TREE_BASE_PX,
  slotLeft,
  textLeft: (depth) => slotLeft(depth) + 20,
  detailedLeft: (depth) => slotLeft(depth) + 4,
};
