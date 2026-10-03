import type { ProjectSortOrder } from '@/stores/useSessionDisplayStore';

/** The fields any project list needs to be sortable. Both the desktop sidebar
    and the mobile sessions drawer build their own richer project shapes on top
    of the store entries, so this stays structural. */
export type SortableProject = {
  id: string;
  label?: string | null;
  path: string;
  addedAt?: number | null;
  lastOpenedAt?: number | null;
};

const compareLabels = (left: SortableProject, right: SortableProject): number =>
  (left.label || left.path).toLowerCase().localeCompare((right.label || right.path).toLowerCase());

/** One ordering for every surface that lists projects, so the sidebar and the
    mobile drawer answer the same setting the same way. `manualOrder` is the
    user's drag order (`useProjectsStore.manualProjectOrder`); projects missing
    from it keep their incoming position at the end. */
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
