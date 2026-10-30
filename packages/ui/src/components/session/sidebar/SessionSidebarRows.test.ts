import { describe, expect, test } from 'bun:test';
import {
  estimateSessionSidebarRowSize,
  findFirstVisibleSessionSidebarRowIndex,
  getInitialSessionSidebarRowIndexes,
  mergeSessionSidebarVirtualIndexes,
  sectionSpacingAfter,
  sessionSidebarRowVirtualKey,
  sessionSidebarRowSizeKey,
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
  const input = (withChats: boolean): SessionSidebarRowModelArgs => {
    const sections: ProjectSection[] = [{
      project: { id: 'project-a', normalizedPath: '/repo' },
      groups: [{ id: 'main', label: 'main', branch: null, description: null, isMain: true, worktree: null, directory: '/repo', folderScopeKey: '/repo', sessions: [node('working'), node('other')] }],
    }];
    const chatGroup = withChats
      ? { id: 'chats', label: 'Chats', branch: null, description: null, isMain: true, worktree: null, directory: '/chats', folderScopeKey: '/chats', sessions: [node('chat')] }
      : null;
    return {
      mode: 'normal', sections, authoritativeSections: sections, chatGroup,
      workEntries: [{ kind: 'session', item: item('working') }], zoneSessionIds: new Set(['working']),
      foldersMap: {}, groupSearchDataByGroup: new WeakMap(), normalizedQuery: '',
      collapsedProjects: new Set(), collapsedGroups: new Set(), collapsedFolders: new Set(), collapsedActivities: new Set(),
      expandedParents: new Set(), visibleCountByContainer: new Map(), pinnedSessionIds: new Set(), sessionOrderIndex: new Map(),
      groupStatusByKey: new Map(), folderAuthorityByOwner: new Map([['project-a', { scopeKeys: ['/repo'], complete: true }]]), sessionOwnerById: new Map(),
      activeProjectId: 'project-a', singleProjectMode: false, singleProjectId: null, showOnlyMainWorkspace: false, hideDirectoryControls: false,
    };
  };
  const spacingBefore = (rows: readonly SessionSidebarRow[], kind: SessionSidebarRow['kind'], key?: string) => {
    const index = rows.findIndex((row) => row.kind === kind && (key === undefined || row.key === key));
    return sectionSpacingAfter(rows[index - 1], rows[index]);
  };

  test('a zone opens with the widest gap, and a project after rows with a wide one', () => {
    for (const withChats of [true, false]) {
      const rows = buildSessionSidebarRowModel(input(withChats)).rows;
      if (withChats) expect(spacingBefore(rows, 'activity-header', 'activity:work:header')).toBe('pb-5');
      expect(spacingBefore(rows, 'project-header')).toBe('pb-3');
    }
  });

  test('the desktop captions the projects when zones list above them, with no gap between caption and project', () => {
    const captioned = buildSessionSidebarRowModel({ ...input(true), projectsCaption: true }).rows;
    const caption = captioned.findIndex((row) => row.kind === 'caption');
    expect(caption).toBeGreaterThan(0);
    expect(captioned[caption + 1]?.kind).toBe('project-header');
    expect(sectionSpacingAfter(captioned[caption], captioned[caption + 1])).toBeUndefined();
    expect(sectionSpacingAfter(captioned[caption - 1], captioned[caption])).toBe('pb-5');
    expect(buildSessionSidebarRowModel(input(true)).rows.some((row) => row.kind === 'caption')).toBe(false);
  });

  test('closing the Projects caption folds every project away', () => {
    const closed = buildSessionSidebarRowModel({ ...input(true), projectsCaption: true, collapsedActivities: new Set(['projects']) }).rows;
    expect(closed.at(-1)?.kind).toBe('caption');
    expect(closed.some((row) => row.kind === 'project-header')).toBe(false);
  });

  test('a row that ends a section is estimated as its siblings plus its gap', () => {
    const rows = buildSessionSidebarRowModel(input(true)).rows;
    const lastBeforeProjects = rows.findIndex((row) => row.kind === 'project-header') - 1;
    const last = rows[lastBeforeProjects];
    expect(last.kind).toBe('session');
    expect(estimateSessionSidebarRowSize(last, rows[lastBeforeProjects + 1])).toBe(last.estimateSize + 12);
    // A sibling measured mid-section tells its height; the gap is added as measured.
    expect(estimateSessionSidebarRowSize(last, rows[lastBeforeProjects + 1], { height: 30, gapBySpacing: new Map([['pb-3', 18]]) })).toBe(48);
    expect(estimateSessionSidebarRowSize(last, undefined, { height: 30 })).toBe(30);
  });

  test('detailed sessions keep independent height measurements while compact rows share theirs', () => {
    const rows = buildSessionSidebarRowModel({ ...input(false), detailedZoneRows: true }).rows;
    const sessions = rows.filter((row): row is Extract<SessionSidebarRow, { kind: 'session' }> => row.kind === 'session' && row.renderContext === 'project');
    expect(sessions).toHaveLength(2);
    const heights = new Map([[sessionSidebarRowSizeKey(sessions[0]), 34]]);
    expect(heights.get(sessionSidebarRowSizeKey(sessions[1]))).toBeUndefined();
    expect(sessionSidebarRowSizeKey({ ...sessions[0], detailed: false }))
      .toBe(sessionSidebarRowSizeKey({ ...sessions[1], detailed: false }));
  });

  test('a header gaining its gap as it closes is a new virtual item, so its old height is not reused', () => {
    const workHeader = (collapsedActivities: Set<string>) => {
      const rows = buildSessionSidebarRowModel({ ...input(true), collapsedActivities }).rows;
      const index = rows.findIndex((row) => row.kind === 'activity-header' && row.activityKey === 'work');
      return { key: rows[index].key, virtualKey: sessionSidebarRowVirtualKey(rows[index], rows[index + 1]) };
    };
    const open = workHeader(new Set());
    // Closed, the zone is followed by the next section and takes its gap.
    const closed = workHeader(new Set(['work']));

    expect(closed.key).toBe(open.key);
    expect(closed.virtualKey).not.toBe(open.virtualKey);
  });
});
