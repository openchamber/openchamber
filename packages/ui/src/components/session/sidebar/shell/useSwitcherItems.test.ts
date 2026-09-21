import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';

import {
  findSwitcherItemAncestorIds,
  selectSwitcherParents,
  type SwitcherItem,
} from './useSwitcherItems';

const session = (id: string, options: { parentID?: string; archived?: boolean; projectId?: string } = {}): Session => ({
  id,
  parentID: options.parentID,
  time: options.archived ? { archived: Date.now() } : undefined,
  projectId: options.projectId ?? 'project-a',
} as unknown as Session);

const selectParents = (sessions: Session[], currentSessionId: string | null, scopeProjectId: string | null = null): Session[] => (
  selectSwitcherParents(sessions, new Set(), new Map(), scopeProjectId, currentSessionId, (item) => (item as Session & { projectId: string }).projectId)
);

describe('session switcher initial selection', () => {
  test('finds all local ancestors for a current child session', () => {
    const items: SwitcherItem[] = [{
      node: { session: session('root'), worktree: null, children: [{ session: session('parent', { parentID: 'root' }), worktree: null, children: [{ session: session('child', { parentID: 'parent' }), worktree: null, children: [] }] }] },
      projectId: 'project-a', groupDirectory: null, secondaryMeta: null,
    }];

    expect(findSwitcherItemAncestorIds(items, 'child')).toEqual(['root', 'parent']);
    expect(findSwitcherItemAncestorIds(items, 'missing')).toBeNull();
  });

  test('replaces the final recent slot with the current root and excludes invalid current sessions', () => {
    const roots = Array.from({ length: 8 }, (_, index) => session(`root-${index}`));
    const child = session('child', { parentID: 'root-7' });

    expect(selectParents([...roots, child], 'child').map((item) => item.id)).toEqual([
      'root-0', 'root-1', 'root-2', 'root-3', 'root-4', 'root-5', 'root-7',
    ]);
    expect(selectParents([...roots, child], 'missing').map((item) => item.id)).toEqual(roots.slice(0, 7).map((item) => item.id));
    expect(selectParents([...roots, child], 'child', 'project-b').map((item) => item.id)).toEqual([]);
    expect(selectParents([...roots.slice(0, 7), session('archived', { archived: true })], 'archived').map((item) => item.id)).toEqual(roots.slice(0, 7).map((item) => item.id));
    expect(selectParents([...roots, session('archived-child', { archived: true, parentID: 'root-7' })], 'archived-child').map((item) => item.id)).toEqual(roots.slice(0, 7).map((item) => item.id));
  });
});
