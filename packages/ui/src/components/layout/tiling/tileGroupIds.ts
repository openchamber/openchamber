import type { SplitNode } from './splitTree';

export const mapTileIdsToGroupIds = (root: SplitNode): ReadonlyMap<string, string> => {
  const result = new Map<string, string>();
  const visit = (node: SplitNode): void => {
    if (node.kind === 'group') {
      for (const tileID of node.tileIds) result.set(tileID, node.id);
      return;
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return result;
};

export const isSoleTileSourceRegion = (
  groupTileIds: readonly string[],
  activeTileId: string | null,
): boolean =>
  activeTileId !== null && groupTileIds.length === 1 && groupTileIds[0] === activeTileId;
