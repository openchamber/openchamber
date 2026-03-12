import React from 'react';
import type { SessionGroup } from '../types';

export const useGroupOrdering = (groupOrderByProject: Map<string, string[]>) => {
  const getOrderedGroups = React.useCallback(
    (projectId: string, groups: SessionGroup[]) => {
      const archivedGroup = groups.find((group) => group.isArchivedBucket === true) ?? null;
      const reorderableGroups = archivedGroup ? groups.filter((group) => group !== archivedGroup) : groups;
      const preferredOrder = groupOrderByProject.get(projectId);
      if (!preferredOrder || preferredOrder.length === 0) {
        return archivedGroup ? [...reorderableGroups, archivedGroup] : reorderableGroups;
      }
      const groupById = new Map(reorderableGroups.map((group) => [group.id, group]));
      const ordered: SessionGroup[] = [];
      preferredOrder.forEach((id) => {
        const group = groupById.get(id);
        if (group) {
          ordered.push(group);
          groupById.delete(id);
        }
      });
      reorderableGroups.forEach((group) => {
        if (groupById.has(group.id)) {
          ordered.push(group);
        }
      });
      return archivedGroup ? [...ordered, archivedGroup] : ordered;
    },
    [groupOrderByProject],
  );

  return { getOrderedGroups };
};
