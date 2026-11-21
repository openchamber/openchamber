export type MobileTreeGeometry = {
  base: number;
  slotLeft: (depth: number) => number;
  textLeft: (depth: number) => number;
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
