import type { ProjectSortOrder } from '@/stores/useSessionDisplayStore';

type SortableProject = {
  id: string;
  label?: string | null;
  path: string;
  addedAt?: number | null;
  lastOpenedAt?: number | null;
};

const compareLabels = (left: SortableProject, right: SortableProject): number =>
  (left.label || left.path).toLowerCase().localeCompare((right.label || right.path).toLowerCase());

export const sortProjectsByOrder = <T extends SortableProject>(
  projects: readonly T[],
  order: ProjectSortOrder,
  manualOrder: readonly string[],
): T[] => {
  const sorted = [...projects];

  switch (order) {
    case 'a-z':
      sorted.sort(compareLabels);
      break;
    case 'z-a':
      sorted.sort((left, right) => compareLabels(right, left));
      break;
    case 'date-added':
      sorted.sort((left, right) => (right.addedAt ?? 0) - (left.addedAt ?? 0));
      break;
    case 'recent':
      sorted.sort((left, right) => (right.lastOpenedAt ?? 0) - (left.lastOpenedAt ?? 0));
      break;
    case 'manual': {
      const rankById = new Map(manualOrder.map((id, index) => [id, index]));
      sorted.sort((left, right) => (rankById.get(left.id) ?? Infinity) - (rankById.get(right.id) ?? Infinity));
      break;
    }
  }

  return sorted;
};

export const rankByLatestActivity = <T>(
  items: readonly T[],
  order: ProjectSortOrder,
  projectIdOf: (item: T) => string,
  sessionsByProject: ReadonlyMap<string, ReadonlyArray<{ time: { updated: number } }>>,
): readonly T[] => {
  if (order !== 'recent') return items;
  const latest = (item: T): number => {
    let newest = 0;
    for (const session of sessionsByProject.get(projectIdOf(item)) ?? []) {
      if (session.time.updated > newest) newest = session.time.updated;
    }
    return newest;
  };
  const ranked = items.map((item) => ({ item, at: latest(item) }));
  ranked.sort((left, right) => right.at - left.at);
  return ranked.map((entry) => entry.item);
};

export const orderByProjectRank = <T extends { id: string }>(
  items: readonly T[],
  rankById: ReadonlyMap<string, number>,
): T[] => {
  const rankOf = (item: T): number => rankById.get(item.id) ?? -1;
  return [...items].sort((left, right) => rankOf(left) - rankOf(right));
};

export const holdOrder = <T>(
  items: readonly T[],
  heldIds: readonly string[],
  idOf: (item: T) => string,
): readonly T[] => {
  const rank = new Map(heldIds.map((id, index) => [id, index]));
  const held: T[] = [];
  const fresh: T[] = [];
  for (const item of items) {
    (rank.has(idOf(item)) ? held : fresh).push(item);
  }
  held.sort((left, right) => (rank.get(idOf(left)) ?? 0) - (rank.get(idOf(right)) ?? 0));
  return [...held, ...fresh];
};
