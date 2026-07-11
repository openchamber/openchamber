import React from 'react';
import type { SessionGroup } from '../types';

export const useGroupOrdering = (groupOrderByProject: Map<string, string[]>) => {
  const getOrderedGroups = React.useCallback(
    (projectId: string, groups: SessionGroup[]) => {
      const preferredOrder = groupOrderByProject.get(projectId);
      if (!preferredOrder || preferredOrder.length === 0) {
        return groups;
      }
      const groupById = new Map(groups.map((group) => [group.id, group]));
      const ordered: SessionGroup[] = [];
      preferredOrder.forEach((id) => {
        const group = groupById.get(id);
        if (group) {
          ordered.push(group);
          groupById.delete(id);
        }
      });
      groups.forEach((group) => {
        if (groupById.has(group.id)) {
          ordered.push(group);
        }
      });
      return ordered;
    },
    [groupOrderByProject],
  );

  return { getOrderedGroups };
};
