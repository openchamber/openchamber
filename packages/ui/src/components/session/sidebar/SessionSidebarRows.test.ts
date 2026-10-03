import { describe, expect, test } from 'bun:test';
import {
  findFirstVisibleSessionSidebarRowIndex,
  getInitialSessionSidebarRowIndexes,
  mergeSessionSidebarVirtualIndexes,
  sectionSpacingAfter,
} from './sessionSidebarVirtualization';
import type { Session } from '@/lib/opencode/model';
import type { SessionNode } from './types';
import type { ProjectSection } from './projects/sessionProjectRender';
import { buildSessionSidebarRowModel, type SessionSidebarActivityItem, type SessionSidebarRow, type SessionSidebarRowModelArgs } from './sessionSidebarRowModel';

describe('SessionSidebarRows initialization', () => {
  test('never mounts the whole model before the scroll element is ready', () => {
    expect(getInitialSessionSidebarRowIndexes(25_000)).toHaveLength(24);
    expect(getInitialSessionSidebarRowIndexes(7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  test('the bounded window includes its last initial row', () => {
    expect(getInitialSessionSidebarRowIndexes(25_000).at(-1)).toBe(23);
  });

  test('ignores stale pinned indexes after a model shrink', () => {
    expect(mergeSessionSidebarVirtualIndexes([0, 1], new Set([2, 99, -1]), 3)).toEqual([0, 1, 2]);
  });

  test('advances at an exact row boundary', () => {
    expect(findFirstVisibleSessionSidebarRowIndex([
      { index: 0, end: 32 },
      { index: 1, end: 64 },
    ], 32)).toBe(1);
  });
});

describe('SessionSidebarRows section spacing', () => {
  // SAFETY: spacing reads only the row identity, kind, and position fields.
  const node = (id: string): SessionNode => ({ session: { id, title: id, directory: '/repo', time: { created: 1, updated: 1 } } as Session, children: [], worktree: null });
  const item = (id: string): SessionSidebarActivityItem => ({ node: node(id), projectId: 'project-a', groupDirectory: '/repo', secondaryMeta: null });
  const input = (showRecentSection: boolean): SessionSidebarRowModelArgs => {
    const sections: ProjectSection[] = [{
      project: { id: 'project-a', normalizedPath: '/repo' },
      groups: [{ id: 'main', label: 'main', branch: null, description: null, isMain: true, worktree: null, directory: '/repo', folderScopeKey: '/repo', sessions: [node('working'), node('other')] }],
    }];
    return {
      mode: 'normal', sections, authoritativeSections: sections, chatGroup: null,
      recentSections: [{ key: 'active-now', items: [item('other')] }], showRecentSection,
      workItems: [item('working')], workSessionIds: new Set(['working']),
      foldersMap: {}, groupSearchDataByGroup: new WeakMap(), normalizedQuery: '',
      collapsedProjects: new Set(), collapsedGroups: new Set(), collapsedFolders: new Set(), collapsedActivities: new Set(),
      expandedParents: new Set(), visibleCountByContainer: new Map(), pinnedSessionIds: new Set(), sessionOrderIndex: new Map(),
      groupStatusByKey: new Map(), folderAuthorityByOwner: new Map([['project-a', { scopeKeys: ['/repo'], complete: true }]]),
      activeProjectId: 'project-a', singleProjectMode: false, singleProjectId: null, showOnlyMainWorkspace: false, hideDirectoryControls: false,
    };
  };
  const spacingBefore = (rows: readonly SessionSidebarRow[], kind: SessionSidebarRow['kind'], key?: string) => {
    const index = rows.findIndex((row) => row.kind === kind && (key === undefined || row.key === key));
    return sectionSpacingAfter(rows[index - 1], rows[index]);
  };

  test('the last zone above the projects ends with the wide gap while Recent is shown', () => {
    const rows = buildSessionSidebarRowModel(input(true)).rows;
    expect(spacingBefore(rows, 'activity-header', 'activity:active-now:header')).toBe('pb-2');
    expect(spacingBefore(rows, 'project-header')).toBe('pb-6');
  });

  test('In work keeps the wide gap above the projects while Recent is hidden', () => {
    const rows = buildSessionSidebarRowModel(input(false)).rows;
    expect(spacingBefore(rows, 'project-header')).toBe('pb-6');
  });
});
