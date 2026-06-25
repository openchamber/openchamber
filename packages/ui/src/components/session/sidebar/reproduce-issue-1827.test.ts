/**
 * Reproduction test for issue #1827:
 * "Sidebar worktree drag-to-reorder snaps back to original position immediately after drop"
 *
 * Root cause: `cachedGetOrderedGroups` in SidebarProjectsList.tsx (lines 103-120)
 * caches ordered groups in a Map keyed by projectId. The cache hit at line 107
 * only checks `hit.groups === groups` (reference equality) — it does NOT track
 * whether the `getOrderedGroups` callback itself has changed.
 *
 * After a drag, `onDragEnd` calls `setGroupOrderByProject`, updating the
 * `groupOrderByProject` state. The parent re-renders and passes a new
 * `getOrderedGroups` callback (because `useGroupOrdering` depends on
 * `groupOrderByProject`). However, `projectSections` is behind a `useMemo`
 * that does NOT depend on `groupOrderByProject`, so `section.groups` keeps
 * the same reference. The cache hits (same groups ref) and returns the stale
 * pre-drag ordering, causing the visual snap-back.
 */
import { describe, expect, test } from 'bun:test';
import type { SessionGroup } from './types';

function makeGroups(ids: string[]): SessionGroup[] {
  return ids.map((id) => ({
    id,
    label: `Group ${id}`,
    branch: null,
    description: null,
    isMain: id === 'main',
    isArchivedBucket: false,
    worktree: null,
    directory: null,
    sessions: [],
  }));
}

/**
 * Replicates the EXACT cachedGetOrderedGroups logic from
 * SidebarProjectsList.tsx lines 103-120.
 *
 * In React, this function is defined inline inside the component body,
 * so it closes over the current `props.getOrderedGroups` each render.
 * We simulate this by accepting the callback at construction time.
 */
function createCachedOrdering(
  getOrderedGroups: (projectId: string, groups: SessionGroup[]) => SessionGroup[],
) {
  const cache = new Map<string, { groups: SessionGroup[]; ordered: SessionGroup[] }>();

  const cachedGetOrderedGroups = (projectId: string, groups: SessionGroup[]): SessionGroup[] => {
    const hit = cache.get(projectId);
    if (hit && hit.groups === groups) {
      // BUG: This returns stale data when getOrderedGroups has changed
      // but groups reference has not.
      return hit.ordered;
    }
    const ordered = getOrderedGroups(projectId, groups);
    cache.set(projectId, { groups, ordered });
    if (cache.size > 256) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
    return ordered;
  };

  return { cachedGetOrderedGroups, cache };
}

describe('Issue #1827: Sidebar worktree drag-to-reorder snap-back', () => {
  test('cache returns stale ordering when getOrderedGroups changes but groups reference stays the same', () => {
    // --- Initial render ---
    // getOrderedGroups returns groups in their natural order
    const getOrderedGroupsV1 = (_projectId: string, groups: SessionGroup[]) => groups;

    const { cachedGetOrderedGroups } = createCachedOrdering(getOrderedGroupsV1);

    // This groups array simulates `section.groups` from `useSessionSidebarSections`,
    // which is behind a useMemo that does NOT depend on groupOrderByProject.
    const groups = makeGroups(['main', 'worktree-a', 'worktree-b', 'worktree-c']);
    const projectId = 'project-1';

    // First call: populates cache with natural order
    const initialResult = cachedGetOrderedGroups(projectId, groups);
    expect(initialResult.map((g) => g.id)).toEqual([
      'main', 'worktree-a', 'worktree-b', 'worktree-c',
    ]);

    // --- After drag: state update triggers re-render ---
    // Parent re-renders with a NEW getOrderedGroups because groupOrderByProject changed.
    // The new callback reorders worktree-c to be first after main.
    const getOrderedGroupsV2 = (_projectId: string, groups: SessionGroup[]) => {
      const groupById = new Map(groups.map((g) => [g.id, g]));
      const customOrder = ['main', 'worktree-c', 'worktree-a', 'worktree-b'];
      const ordered: SessionGroup[] = [];
      for (const id of customOrder) {
        const g = groupById.get(id);
        if (g) {
          ordered.push(g);
          groupById.delete(id);
        }
      }
      groups.forEach((g) => {
        if (groupById.has(g.id)) ordered.push(g);
      });
      return ordered;
    };

    // BUG REPRODUCTION:
    // The component re-renders. `cachedGetOrderedGroups` is re-created in the
    // component body, closing over the new `getOrderedGroupsV2`. BUT the cache
    // persisted across renders (it's in a ref!). The `groups` reference is the
    // SAME as before because `projectSections` didn't recompute.
    //
    // Result: cache HIT (same groups ref) → returns stale pre-drag ordering.

    // Simulate re-creating the function in a new render with the V2 callback:
    const { cachedGetOrderedGroups: cachedGetOrderedGroupsV2 } = createCachedOrdering(getOrderedGroupsV2);

    // In the real component, the cache is in a ref, so it persists across renders.
    // We simulate this by NOT clearing the cache between calls.
    //
    // However! Our `createCachedOrdering` creates a NEW cache each time.
    // In the real React component, the cache ref persists. So we need to
    // simulate this differently.
    //
    // Let me fix this: the cache persists, the closure updates.

    // ACTUALLY, let me re-think. In the React component:
    // - `orderedGroupsCacheRef` is a useRef - persists across renders
    // - `cachedGetOrderedGroups` is re-created each render body, closing over
    //   current `props.getOrderedGroups`
    // - So when the component re-renders:
    //   1. `cachedGetOrderedGroups` now closes over `getOrderedGroupsV2`
    //   2. `orderedGroupsCacheRef.current` still has the old cached data
    //   3. Call with same groups ref → cache HIT → returns stale data
    //
    // The cache HIT prevents the new `getOrderedGroupsV2` from ever being called.

    // Let's pull the cache out so it persists like a useRef:
    const persistentCache = new Map<string, { groups: SessionGroup[]; ordered: SessionGroup[] }>();

    // V1 render:
    const cachedV1 = (projectId: string, groups: SessionGroup[]): SessionGroup[] => {
      const hit = persistentCache.get(projectId);
      if (hit && hit.groups === groups) {
        return hit.ordered;
      }
      const ordered = getOrderedGroupsV1(projectId, groups);
      persistentCache.set(projectId, { groups, ordered });
      return ordered;
    };

    // Call with V1
    const v1Result = cachedV1(projectId, groups);
    expect(v1Result.map((g) => g.id)).toEqual(['main', 'worktree-a', 'worktree-b', 'worktree-c']);

    // V2 render (same persistent cache, new getOrderedGroups):
    const cachedV2 = (projectId: string, groups: SessionGroup[]): SessionGroup[] => {
      const hit = persistentCache.get(projectId);
      if (hit && hit.groups === groups) {
        // BUG: hit.groups === groups is TRUE (same array reference)
        // Returns 'main', 'worktree-a', 'worktree-b', 'worktree-c' (STALE!)
        return hit.ordered;
      }
      const ordered = getOrderedGroupsV2(projectId, groups);
      persistentCache.set(projectId, { groups, ordered });
      return ordered;
    };

    // Call with V2 - should return new order but returns STALE order due to cache hit
    const v2Result = cachedV2(projectId, groups);
    expect(v2Result.map((g) => g.id)).toEqual(['main', 'worktree-a', 'worktree-b', 'worktree-c']);
    // Expected (if no bug): ['main', 'worktree-c', 'worktree-a', 'worktree-b']

    // This shows the bug: the cache returned stale data even though
    // getOrderedGroups changed to include the new ordering.
  });

  test('fix: tracking getOrderedGroups changes and clearing the cache resolves the issue', () => {
    // Simulate the fix: when getOrderedGroups changes, clear the cache ref.
    // The cache ref is orderedGroupsCacheRef.current.
    // The fix checks: if props.getOrderedGroups !== last seen, clear cache.

    const persistentCache = new Map<string, { groups: SessionGroup[]; ordered: SessionGroup[] }>();
    const groups = makeGroups(['main', 'worktree-a', 'worktree-b', 'worktree-c']);
    const projectId = 'project-1';

    // V1 render:
    const getOrderedGroupsV1 = (_projectId: string, groups: SessionGroup[]) => groups;

    let lastGetOrderedGroups: typeof getOrderedGroupsV1 | null = null;
    const checkAndClearCache = (newGetOrderedGroups: typeof getOrderedGroupsV1) => {
      if (lastGetOrderedGroups !== newGetOrderedGroups) {
        lastGetOrderedGroups = newGetOrderedGroups;
        persistentCache.clear();
      }
    };

    checkAndClearCache(getOrderedGroupsV1);
    const cachedV1 = (projectId: string, groups: SessionGroup[]): SessionGroup[] => {
      const hit = persistentCache.get(projectId);
      if (hit && hit.groups === groups) {
        return hit.ordered;
      }
      const ordered = getOrderedGroupsV1(projectId, groups);
      persistentCache.set(projectId, { groups, ordered });
      return ordered;
    };

    const v1Result = cachedV1(projectId, groups);
    expect(v1Result.map((g) => g.id)).toEqual(['main', 'worktree-a', 'worktree-b', 'worktree-c']);

    // V2 render with new getOrderedGroups:
    const getOrderedGroupsV2 = (_projectId: string, groups: SessionGroup[]) => {
      const groupById = new Map(groups.map((g) => [g.id, g]));
      const customOrder = ['main', 'worktree-c', 'worktree-a', 'worktree-b'];
      const ordered: SessionGroup[] = [];
      for (const id of customOrder) {
        const g = groupById.get(id);
        if (g) {
          ordered.push(g);
          groupById.delete(id);
        }
      }
      groups.forEach((g) => {
        if (groupById.has(g.id)) ordered.push(g);
      });
      return ordered;
    };

    // FIX: detect callback change and clear cache
    checkAndClearCache(getOrderedGroupsV2);

    const cachedV2 = (projectId: string, groups: SessionGroup[]): SessionGroup[] => {
      const hit = persistentCache.get(projectId);
      if (hit && hit.groups === groups) {
        return hit.ordered;
      }
      const ordered = getOrderedGroupsV2(projectId, groups);
      persistentCache.set(projectId, { groups, ordered });
      return ordered;
    };

    // Same groups reference, but cache was cleared due to the fix
    const v2Result = cachedV2(projectId, groups);
    expect(v2Result.map((g) => g.id)).toEqual(['main', 'worktree-c', 'worktree-a', 'worktree-b']);
    // CORRECT: new ordering is returned immediately
  });
});
