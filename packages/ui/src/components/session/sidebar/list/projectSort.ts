import type { ProjectSortOrder } from '@/stores/useSessionDisplayStore';

/** The fields any project list needs to be sortable. Both the desktop sidebar
    and the mobile sessions drawer build their own richer project shapes on top
    of the store entries, so this stays structural. */
type SortableProject = {
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

/**
 * The "recent" order once sessions are known: newest session activity in the
 * project (its root and worktrees) first. Projects with no session keep their
 * incoming order after the active ones, so the last-opened order still breaks
 * ties. Every other sort passes through unchanged.
 */
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

/**
 * Keep `items` in a previously shown order. Items in `heldIds` keep their
 * place; items that appeared since follow in their live order. Used to stop
 * the "recent" sort from reshuffling projects under the pointer.
 */
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
