import type { PanelLayout, SplitNode } from './splitTree';

const collectActiveTileIds = (node: SplitNode, visibleTileIds: Set<string>): void => {
  if (node.kind === 'group') {
    visibleTileIds.add(node.activeTileId);
    return;
  }

  for (const child of node.children) {
    collectActiveTileIds(child, visibleTileIds);
  }
};

export const computeVisibleTileIds = (layout: PanelLayout | null, panelOpen: boolean): Set<string> => {
  const visibleTileIds = new Set<string>();
  if (!panelOpen || !layout) {
    return visibleTileIds;
  }

  collectActiveTileIds(layout.root, visibleTileIds);
  return visibleTileIds;
};
