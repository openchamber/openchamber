import { describe, expect, test } from 'bun:test';
import { Virtualizer } from '@tanstack/react-virtual';
import {
  estimateSessionSidebarRowSize,
  findFirstVisibleSessionSidebarRowIndex,
  findSessionSidebarScrollAnchor,
  getInitialSessionSidebarRowIndexes,
  mergeSessionSidebarVirtualIndexes,
  resolveSessionSidebarScrollAnchor,
  sectionSpacingAfter,
  isSessionSidebarUserChange,
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

  test('a row that turns between one and two lines is a new virtual item, so the other mode\'s height is not reused', () => {
    const detailed = buildSessionSidebarRowModel({ ...input(true), detailedZoneRows: true }).rows;
    const compact = buildSessionSidebarRowModel({ ...input(true), detailedZoneRows: false }).rows;
    const virtualKey = (rows: readonly SessionSidebarRow[], key: string) => {
      const index = rows.findIndex((row) => row.key === key);
      return sessionSidebarRowVirtualKey(rows[index], rows[index + 1]);
    };
    const projectSession = detailed.find((row) => row.kind === 'session' && row.node.session.id === 'other');

    expect(projectSession).toBeDefined();
    expect(compact.some((row) => row.key === projectSession?.key)).toBe(true);
    expect(virtualKey(detailed, projectSession!.key)).not.toBe(virtualKey(compact, projectSession!.key));
  });
});

describe('SessionSidebarRows scroll anchor', () => {
  // SAFETY: the anchor reads only row keys and the size keys of the row model's own rows.
  const node = (id: string, children: readonly string[] = []): SessionNode => ({ session: { id, title: id, directory: '/repo', time: { created: 1, updated: 1 } } as Session, children: children.map((child) => node(child)), worktree: null });
  type Options = { detailed?: boolean; collapsedProjects?: Set<string>; sessionIds?: string[]; visible?: number; mode?: 'normal' | 'search'; projectOrder?: string[]; childrenOf?: Record<string, string[]>; otherIds?: string[] };
  const ids = (count: number) => Array.from({ length: count }, (_, index) => `session-${index}`);
  const model = ({ detailed = true, collapsedProjects = new Set<string>(), sessionIds = ids(40), visible = 60, mode = 'normal', projectOrder = ['project-a', 'project-b'], childrenOf = {}, otherIds = ['other-0', 'other-1'] }: Options = {}) => {
    const sectionById = new Map<string, ProjectSection>(['project-a', 'project-b'].map((id) => [id, {
      project: { id, normalizedPath: `/${id}` },
      groups: [{ id: 'main', label: 'main', branch: null, description: null, isMain: true, worktree: null, directory: `/${id}`, folderScopeKey: `/${id}`, sessions: (id === 'project-a' ? sessionIds : otherIds).map((sessionId) => node(sessionId, childrenOf[sessionId])) }],
    }]));
    const sections = projectOrder.map((id) => sectionById.get(id)!);
    const args: SessionSidebarRowModelArgs = {
      mode, sections, authoritativeSections: sections, chatGroup: null,
      workEntries: [], zoneSessionIds: new Set(),
      foldersMap: {}, groupSearchDataByGroup: new WeakMap(), normalizedQuery: mode === 'search' ? 'session' : '',
      collapsedProjects, collapsedGroups: new Set(), collapsedFolders: new Set(), collapsedActivities: new Set(),
      expandedParents: new Set(Object.keys(childrenOf).map((parent) => `project:active:${parent}`)), visibleCountByContainer: new Map([['project-a:main', visible], ['project-b:main', 100]]), pinnedSessionIds: new Set(), sessionOrderIndex: new Map([...sessionIds, ...otherIds].map((id, index) => [id, index])),
      groupStatusByKey: new Map(), folderAuthorityByOwner: new Map(['project-a', 'project-b'].map((id) => [id, { scopeKeys: [`/${id}`], complete: true }])), sessionOwnerById: new Map(),
      activeProjectId: 'project-a', singleProjectMode: false, singleProjectId: null, showOnlyMainWorkspace: false, hideDirectoryControls: false,
      detailedZoneRows: detailed,
    };
    return buildSessionSidebarRowModel(args);
  };
  // Lays the rows out the way the virtualizer does once every row is measured.
  const layout = (rows: readonly SessionSidebarRow[]) => {
    let start = 0;
    return rows.map((row, index) => {
      const size = row.kind === 'session' ? ('detailed' in row && row.detailed ? 51 : 32) : 28;
      const item = { index, start, size, end: start + size };
      start += size;
      return item;
    });
  };
  const rowAt = (rows: readonly SessionSidebarRow[], items: ReturnType<typeof layout>, line: number) => {
    const item = items.find((candidate) => candidate.end > line)!;
    return { key: rows[item.index].key, into: line - item.start };
  };
  const sessionIndex = (rows: readonly SessionSidebarRow[], id: string) => rows.findIndex((row) => row.kind === 'session' && row.node.session.id === id);
  // Where the line lands after the change, with the list keeping its anchor.
  const follow = (before: ReturnType<typeof model>, after: ReturnType<typeof model>, line: number, viewport = 400) => {
    const anchor = findSessionSidebarScrollAnchor(before.rows, layout(before.rows), line, line + viewport, after.rowIndexByKey);
    return anchor ? resolveSessionSidebarScrollAnchor(anchor, after.rowIndexByKey, layout(after.rows)) : null;
  };

  test('turning Detailed rows off and on keeps the row under the line where it was', () => {
    const detailed = model({ detailed: true });
    const compact = model({ detailed: false });
    const detailedLayout = layout(detailed.rows);
    const compactLayout = layout(compact.rows);
    expect(isSessionSidebarUserChange(detailed, compact)).toBe(false);

    // Deep in the list, 20px into a session row: with the scroll position kept,
    // the compact list would show a session much further down.
    const index = sessionIndex(detailed.rows, 'session-25');
    const line = detailedLayout[index].start + 20;
    expect(rowAt(compact.rows, compactLayout, line).key).not.toBe(detailed.rows[index].key);

    const compactLine = follow(detailed, compact, line)!;
    expect(rowAt(compact.rows, compactLayout, compactLine).key).toBe(detailed.rows[index].key);
    expect(rowAt(compact.rows, compactLayout, compactLine).into).toBeCloseTo(20 * 32 / 51);

    // Back to Detailed rows: the same row, the same pixel.
    expect(follow(compact, detailed, compactLine)).toBeCloseTo(line);
  });

  test('sessions arriving or leaving above keep the rows on screen in place', () => {
    const before = model();
    const line = layout(before.rows)[sessionIndex(before.rows, 'session-25')].start + 10;
    const arrived = model({ sessionIds: ['new-1', 'new-2', ...ids(40)] });
    expect(isSessionSidebarUserChange(before, arrived)).toBe(false);
    expect(rowAt(arrived.rows, layout(arrived.rows), follow(before, arrived, line)!)).toEqual({ key: before.rows[sessionIndex(before.rows, 'session-25')].key, into: 10 });

    const left = model({ sessionIds: ids(40).filter((id) => id !== 'session-3') });
    expect(rowAt(left.rows, layout(left.rows), follow(before, left, line)!).key).toBe(before.rows[sessionIndex(before.rows, 'session-25')].key);
  });

  test('a row on screen that moves to the top is not followed there', () => {
    const before = model();
    const items = layout(before.rows);
    const line = items[sessionIndex(before.rows, 'session-25')].start + 10;
    // session-25 became active and went to the top of its project.
    const moved = model({ sessionIds: ['session-25', ...ids(40).filter((id) => id !== 'session-25')] });
    const nextLine = follow(before, moved, line)!;
    // The row that was below it stays where it was.
    const below = before.rows[sessionIndex(before.rows, 'session-26')].key;
    const belowStart = items[sessionIndex(before.rows, 'session-26')].start;
    const movedItems = layout(moved.rows);
    expect(movedItems[moved.rowIndexByKey.get(below)!].start - nextLine).toBe(belowStart - line);
  });

  test('an open session moving to the top with its subsessions is not followed there', () => {
    const childrenOf = { 'session-25': ['child-a', 'child-b'] };
    const before = model({ childrenOf });
    const items = layout(before.rows);
    const child = before.rowIndexByKey.get(before.rows.find((row) => row.kind === 'session' && row.node.session.id === 'child-a')!.key)!;
    const line = items[child].start + 10;
    const moved = model({ childrenOf, sessionIds: ['session-25', ...ids(40).filter((id) => id !== 'session-25')] });
    const nextLine = follow(before, moved, line)!;
    // The session that was under the moved block stays where it was.
    const below = before.rows[sessionIndex(before.rows, 'session-26')].key;
    const movedItems = layout(moved.rows);
    expect(movedItems[moved.rowIndexByKey.get(below)!].start - nextLine).toBe(items[sessionIndex(before.rows, 'session-26')].start - line);
  });

  test('an open session filling most of the screen is not followed to the top either', () => {
    const childrenOf = { 'session-24': Array.from({ length: 8 }, (_, index) => `child-${index}`) };
    const before = model({ childrenOf });
    const items = layout(before.rows);
    const child = before.rowIndexByKey.get(before.rows.find((row) => row.kind === 'session' && row.node.session.id === 'child-0')!.key)!;
    const line = items[child].start + 10;
    const moved = model({ childrenOf, sessionIds: ['session-24', ...ids(40).filter((id) => id !== 'session-24')] });
    // A short viewport: the moved subsessions are most of what shows.
    const nextLine = follow(before, moved, line, 320)!;
    const below = before.rows[sessionIndex(before.rows, 'session-25')].key;
    const movedItems = layout(moved.rows);
    expect(movedItems[moved.rowIndexByKey.get(below)!].start - nextLine).toBe(items[sessionIndex(before.rows, 'session-25')].start - line);
  });

  test('an open tree longer than the list above it is not followed to the top', () => {
    const childrenOf = { 'session-24': Array.from({ length: 30 }, (_, index) => `child-${index}`) };
    const before = model({ childrenOf });
    const items = layout(before.rows);
    const child = before.rowIndexByKey.get(before.rows.find((row) => row.kind === 'session' && row.node.session.id === 'child-27')!.key)!;
    const line = items[child].start + 10;
    const moved = model({ childrenOf, sessionIds: ['session-24', ...ids(40).filter((id) => id !== 'session-24')] });
    const nextLine = follow(before, moved, line, 320)!;
    const below = before.rows[sessionIndex(before.rows, 'session-25')].key;
    const movedItems = layout(moved.rows);
    expect(movedItems[moved.rowIndexByKey.get(below)!].start - nextLine).toBe(items[sessionIndex(before.rows, 'session-25')].start - line);
  });

  test('a subsession deleted under the line hands the anchor to the row after it', () => {
    const before = model({ childrenOf: { 'session-25': ['child-a', 'child-b'] } });
    const items = layout(before.rows);
    const childA = before.rows.findIndex((row) => row.kind === 'session' && row.node.session.id === 'child-a');
    const childB = childA + 1;
    const line = items[childA].start + 10;
    const after = model({ childrenOf: { 'session-25': ['child-b'] } });
    const nextLine = follow(before, after, line)!;
    const afterItems = layout(after.rows);
    expect(afterItems[after.rowIndexByKey.get(before.rows[childB].key)!].start - nextLine).toBe(items[childB].start - line);
  });

  test('a subsession leaving its open parent above is not the user closing it', () => {
    const before = model({ childrenOf: { 'session-3': ['child-a'] } });
    const after = model({ childrenOf: { 'session-3': [] } });
    expect(isSessionSidebarUserChange(before, after)).toBe(false);
    expect(isSessionSidebarUserChange(after, before)).toBe(false);
  });

  test('a session arriving right under the row at the line pushes the rows after it, not that row', () => {
    const before = model();
    const items = layout(before.rows);
    const header = before.rows.findIndex((row) => row.kind === 'project-header');
    // The project header sits under the line; a new session lands right under it.
    const line = items[header].start + 5;
    const arrived = model({ sessionIds: ['new-1', ...ids(40)] });
    expect(follow(before, arrived, line)).toBe(line);
  });

  test('a project moving above on its own keeps the rows on screen in place', () => {
    const before = model();
    const items = layout(before.rows);
    const index = sessionIndex(before.rows, 'session-25');
    const line = items[index].start + 10;
    // Sorted by recent activity, project-b went to the top.
    const after = model({ projectOrder: ['project-b', 'project-a'] });
    expect(rowAt(after.rows, layout(after.rows), follow(before, after, line)!)).toEqual({ key: before.rows[index].key, into: 10 });
  });

  test('a project larger than the one on screen moving above on its own keeps the rows in place', () => {
    const otherIds = Array.from({ length: 60 }, (_, index) => `other-${index}`);
    const before = model({ otherIds });
    const items = layout(before.rows);
    const index = sessionIndex(before.rows, 'session-25');
    const line = items[index].start + 10;
    const after = model({ otherIds, projectOrder: ['project-b', 'project-a'] });
    expect(rowAt(after.rows, layout(after.rows), follow(before, after, line)!)).toEqual({ key: before.rows[index].key, into: 10 });
  });

  test('what the user does to the list keeps its own scrolling', () => {
    const open = model();
    expect(isSessionSidebarUserChange(open, model({ collapsedProjects: new Set(['project-a']) }))).toBe(true);
    expect(isSessionSidebarUserChange(model({ visible: 20 }), model({ visible: 40 }))).toBe(true);
    expect(isSessionSidebarUserChange(open, model({ mode: 'search' }))).toBe(true);
    // A drag holds the row it dropped (`heldRowRef`): the rows look the same
    // as projects sorted by recent activity moving on their own.
    expect(isSessionSidebarUserChange(open, model({ projectOrder: ['project-b', 'project-a'] }))).toBe(false);
    expect(isSessionSidebarUserChange(open, model())).toBe(false);
  });

  test('an anchor row gone from the list leaves the position alone', () => {
    const open = model();
    const closed = model({ collapsedProjects: new Set(['project-a']) });
    const items = layout(open.rows);
    const anchor = findSessionSidebarScrollAnchor(open.rows, items, items[10].start, items[10].start + 400, open.rowIndexByKey)!;
    expect(resolveSessionSidebarScrollAnchor(anchor, closed.rowIndexByKey, layout(closed.rows))).toBeNull();
  });
});

describe('SessionSidebarRows last layout', () => {
  // The header motion reads where the rows were from the virtualizer's
  // measurements as they stood before the rows changed. Rebuilt in place, the
  // entries nobody had read answered with the new layout's numbers
  // (`bun-patches/@tanstack+virtual-core+3.19.6.patch`).
  test('measurements read before the rows changed keep their numbers', () => {
    const options = {
      count: 50,
      getScrollElement: () => null,
      estimateSize: () => 51,
      scrollToFn: () => undefined,
      observeElementRect: () => undefined,
      observeElementOffset: () => undefined,
    };
    const virtualizer = new Virtualizer<HTMLElement, HTMLElement>(options);
    virtualizer.getTotalSize();
    const before = virtualizer.measurementsCache;
    virtualizer.setOptions({ ...options, count: 45, estimateSize: () => 32, getItemKey: (index) => `next-${index}` });
    expect(virtualizer.getTotalSize()).toBe(45 * 32);
    expect(before[40]?.start).toBe(40 * 51);
  });
});
