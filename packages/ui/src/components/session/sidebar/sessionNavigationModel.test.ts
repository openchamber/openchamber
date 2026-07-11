import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';

import type { SessionGroup, SessionNode } from './types';
import { buildProjectNavigationTargets } from './sessionNavigationModel';

const node = (id: string, updated: number, directory = '/project'): SessionNode => ({
  session: {
    id,
    directory,
    time: { created: updated, updated },
  } as Session,
  children: [],
  worktree: null,
});

const group = (id: string, sessions: SessionNode[], options?: { main?: boolean; directory?: string }): SessionGroup => ({
  id,
  label: id,
  branch: null,
  description: null,
  isMain: options?.main ?? false,
  worktree: null,
  directory: options?.directory ?? '/project',
  folderScopeKey: options?.directory ?? '/project',
  sessions,
});

describe('buildProjectNavigationTargets', () => {
  test('follows visual project, root-group, folder, and row order', () => {
    const rootA = node('root-a', 100);
    const rootB = node('root-b', 200);
    const nested = node('nested', 300, '/project/worktree');

    const targets = buildProjectNavigationTargets({
      sections: [{
        project: { id: 'project-a' },
        // Persisted ordering can put a worktree first, but the renderer always
        // hoists the main group above nested groups.
        groups: [group('worktree', [nested], { directory: '/project/worktree' }), group('root', [rootA, rootB], { main: true })],
      }],
      foldersMap: {
        '/project': [
          { id: 'parent', name: 'Parent', sessionIds: ['root-a'], createdAt: 1, parentId: null },
          { id: 'child', name: 'Child', sessionIds: ['root-b'], createdAt: 2, parentId: 'parent' },
        ],
      },
      getOrderedGroups: (_projectId, groups) => groups,
      pinnedSessionIds: new Set(),
      sessionOrderIndex: new Map([
        ['nested', 0],
        ['root-b', 1],
        ['root-a', 2],
      ]),
    });

    expect(targets.map((target) => target.sessionId)).toEqual(['root-b', 'root-a', 'nested']);
    expect(targets[0]?.groupKey).toBe('project-a:root');
    expect(targets[0]?.folderAncestorIds).toEqual(['parent', 'child']);
    expect(targets[1]?.folderAncestorIds).toEqual(['parent']);
    expect(targets[2]?.visibleIndex).toBe(0);
  });

  test('excludes archived and child sessions from the project shortcut ring', () => {
    const child = node('child', 300);
    (child.session as Session & { parentID?: string }).parentID = 'parent';
    const archived = node('archived', 400);
    archived.session.time = { ...archived.session.time, archived: 500 };

    const targets = buildProjectNavigationTargets({
      sections: [{
        project: { id: 'project-a' },
        groups: [group('root', [node('parent', 100), child, archived], { main: true })],
      }],
      foldersMap: {},
      getOrderedGroups: (_projectId, groups) => groups,
      pinnedSessionIds: new Set(),
      sessionOrderIndex: new Map(),
    });

    expect(targets.map((target) => target.sessionId)).toEqual(['parent']);
  });
});
