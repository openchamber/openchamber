import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import type { SessionGroup, SessionNode } from './types';
import type { ProjectSection } from './projects/sessionProjectRender';
import { buildSessionSidebarRowModel, resolveSessionSidebarStickyHeader, type SessionSidebarActivityItem, type SessionSidebarRowModelArgs } from './sessionSidebarRowModel';
import { getPinnedSessionKey } from '@/stores/useSessionPinnedStore';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { deriveRecentActivitySections } from './recent/activitySections';

const timelineItem = (id: string, overrides: Partial<SessionSidebarActivityItem> = {}): SessionSidebarActivityItem => ({
  node: { session: session(id), children: [], worktree: null },
  projectId: 'project-a',
  groupDirectory: '/repo',
  secondaryMeta: { projectLabel: 'repo', branchLabel: 'main' },
  ...overrides,
});

const pinnedIds = (...ids: string[]): Set<string> => new Set(
  ids.flatMap((id) => {
    const key = getPinnedSessionKey(getRuntimeKey(), '/repo', id);
    return key ? [key] : [];
  }),
);

// SAFETY: the row model only reads the supplied session identity, title, directory, parent, and lifecycle fields.
const session = (id: string, parentID?: string): Session => ({
  id,
  title: id,
  directory: '/repo',
  parentID,
  time: { created: 1, updated: 1 },
} as Session);

const node = (id: string, children: SessionNode[] = []): SessionNode => ({ session: session(id), children, worktree: null });

const group = (sessions: SessionNode[], overrides: Partial<SessionGroup> = {}): SessionGroup => ({
  id: 'main',
  label: 'main',
  branch: null,
  description: null,
  isMain: true,
  worktree: null,
  directory: '/repo',
  folderScopeKey: '/repo',
  sessions,
  ...overrides,
});

const project = (groups: SessionGroup[]): ProjectSection => ({
  project: { id: 'project-a', normalizedPath: '/repo' },
  groups,
});

const args = (sections: ProjectSection[]): SessionSidebarRowModelArgs => ({
  mode: 'normal',
  sections,
  authoritativeSections: sections,
  chatGroup: null,
  recentSections: [],
  showRecentSection: false,
  foldersMap: {},
  groupSearchDataByGroup: new WeakMap(),
  normalizedQuery: '',
  collapsedProjects: new Set(),
  collapsedGroups: new Set(),
  collapsedFolders: new Set(),
  collapsedActivities: new Set(),
  expandedParents: new Set(),
  visibleCountByContainer: new Map(),
  pinnedSessionIds: new Set(),
  sessionOrderIndex: new Map(),
  groupStatusByKey: new Map(),
  folderAuthorityByOwner: new Map([['project-a', { scopeKeys: ['/repo'], complete: true }]]),
  activeProjectId: 'project-a',
  singleProjectMode: false,
  singleProjectId: null,
  showOnlyMainWorkspace: false,
  hideDirectoryControls: false,
});

describe('buildSessionSidebarRowModel', () => {
  test('expanded Recent rows use their own tooltip metadata, including an explicitly hidden branch', () => {
    const parent = node('parent', [node('child'), node('hidden')]);
    const branches = new Map([['parent', 'main'], ['child', 'feature-child']]);
    const input = args([]);
    input.showRecentSection = true;
    input.mode = 'search';
    input.recentSections = deriveRecentActivitySections({
      sessions: [parent.session],
      getSessionNode: () => parent,
      getSessionLocation: (id) => ({
        projectId: 'project-a', groupDirectory: '/repo', projectLabel: 'repo',
        branchLabel: branches.get(id) ?? null,
        worktree: null,
      }),
      query: '',
    });
    const rows = buildSessionSidebarRowModel(input).rows.flatMap((row) => row.kind === 'session'
      ? [{ id: row.node.session.id, metadata: row.secondaryMeta }]
      : []);
    expect(rows).toEqual([
      { id: 'parent', metadata: { projectLabel: 'repo', branchLabel: 'main' } },
      { id: 'child', metadata: { projectLabel: 'repo', branchLabel: 'feature-child' } },
      { id: 'hidden', metadata: { projectLabel: 'repo', branchLabel: null } },
    ]);
  });

  test('uses occurrence keys while retaining duplicate session IDs in logical order', () => {
    const repeated = node('same-session');
    const input = args([project([group([repeated])])]);
    input.recentSections = [{
      key: 'active-now',
      items: [{ node: repeated, projectId: 'project-a', groupDirectory: '/repo', secondaryMeta: null }],
    }];
    input.showRecentSection = true;

    const model = buildSessionSidebarRowModel(input);
    const entries = model.selectionEntries.filter((entry) => entry.id === 'same-session');

    expect(entries).toHaveLength(2);
    expect(entries[0]?.rowKey).not.toBe(entries[1]?.rowKey);
    expect(new Set(model.rows.map((row) => row.key)).size).toBe(model.rows.length);
  });

  test('forces descendants open in search without changing persisted expansion state', () => {
    const parent = node('parent', [node('child')]);
    const main = group([parent]);
    const input = args([project([main])]);
    input.mode = 'search';
    input.normalizedQuery = 'child';
    input.groupSearchDataByGroup.set(main, {
      filteredNodes: [parent],
      matchedSessionCount: 1,
      folderNameMatchCount: 0,
      groupMatches: false,
      hasMatch: true,
    });

    const model = buildSessionSidebarRowModel(input);

    expect(model.rows.filter((row) => row.kind === 'session').map((row) => row.node.session.id)).toEqual(['parent', 'child']);
    const parentEntry = model.selectionEntries.find((entry) => entry.id === 'parent');
    expect(parentEntry?.descendantRange).toBeDefined();
    expect(parentEntry?.descendantRange
      ? model.selectionDescendantIds.slice(parentEntry.descendantRange[0], parentEntry.descendantRange[1])
      : []).toEqual(['child']);
    expect(input.expandedParents.size).toBe(0);
  });

  test('enables folder drops only when the owner scope set is authoritative', () => {
    const main = group([node('session-a')]);
    const input = args([project([main])]);
    input.foldersMap = { '/repo': [{ id: 'folder-a', name: 'Folder', sessionIds: ['session-a'], createdAt: 1 }] };

    expect(buildSessionSidebarRowModel(input).folderDropTargets[0]?.enabled).toBe(true);

    input.folderAuthorityByOwner = new Map([['project-a', { scopeKeys: ['/repo'], complete: false }]]);
    expect(buildSessionSidebarRowModel(input).folderDropTargets[0]?.enabled).toBe(false);
  });

  test('keeps a 25,000-session group bounded until show-more is requested', () => {
    const sessions = Array.from({ length: 25_000 }, (_, index) => node(`session-${index}`));
    const model = buildSessionSidebarRowModel(args([project([group(sessions)])]));

    expect(model.rows.filter((row) => row.kind === 'session')).toHaveLength(5);
    expect(model.rows.some((row) => row.kind === 'show-control' && row.control === 'more')).toBe(true);
  });

  test('single-project flat mode reveals twenty at a time and resets without changing Chats', () => {
    const nodes = Array.from({ length: 45 }, (_, index) => node(`session-${index}`));
    const input = args([project([group(nodes)])]);
    input.singleProjectMode = true;
    input.singleProjectId = 'project-a';
    input.sessionBatchSize = 20;
    input.chatGroup = group(nodes, { id: 'managed-chats' });
    for (const count of [20, 40, 45]) {
      const model = buildSessionSidebarRowModel(input);
      expect(model.rows.filter((row) => row.kind === 'session' && row.projectId === 'project-a')).toHaveLength(count);
      expect(model.rows.filter((row) => row.kind === 'session' && row.projectId === null)).toHaveLength(5);
      const control = model.rows.find((row) => row.kind === 'show-control' && row.containerKey === 'project-a:main');
      if (!control || control.kind !== 'show-control') throw new Error('Missing reveal control');
      expect(control.increment).toBe(20);
      expect(control.control).toBe(count === 45 ? 'fewer' : 'more');
      if (control.control === 'more') input.visibleCountByContainer = new Map([[control.containerKey, control.currentCount + control.increment]]);
      else input.visibleCountByContainer = new Map();
    }
    expect(buildSessionSidebarRowModel(input).rows.filter((row) => row.kind === 'session' && row.projectId === 'project-a')).toHaveLength(20);
  });

  test('Chats failure stays visible beside retained sessions', () => {
    const input = args([]);
    input.chatGroup = group([node('retained-chat')], { id: 'managed-chats' });
    input.groupStatusByKey = new Map([['activity:chats', { state: 'load-failed', directory: '/chats', canGrantAccess: false }]]);
    const rows = buildSessionSidebarRowModel(input).rows;
    expect(rows.some((row) => row.kind === 'session' && row.node.session.id === 'retained-chat')).toBe(true);
    expect(rows.find((row) => row.kind === 'status')).toMatchObject({ groupKey: 'activity:chats', status: { state: 'load-failed' } });
    expect(rows.some((row) => row.kind === 'empty')).toBe(false);
  });

  test('a collapsed folder retains activity coverage from nested folders without flattening subtasks', () => {
    const child = node('child');
    child.session.parentID = 'parent';
    const parent = node('parent', [child]);
    const input = args([project([group([parent])])]);
    input.foldersMap = { '/repo': [
      { id: 'outer', name: 'Outer', createdAt: 1, sessionIds: [] },
      { id: 'inner', name: 'Inner', parentId: 'outer', createdAt: 1, sessionIds: ['parent', 'child'] },
    ] };
    input.collapsedFolders = new Set(['outer']);
    const model = buildSessionSidebarRowModel(input);
    const folder = model.rows.find((row) => row.kind === 'folder-header');
    if (!folder || folder.kind !== 'folder-header') throw new Error('Missing outer folder');
    expect(folder.nodes).toEqual([]);
    expect(folder.activityNodes).toEqual([parent]);
    expect(folder.activityNodes[0]?.children).toEqual([child]);
    expect(model.rows.filter((row) => row.kind === 'folder-header')).toHaveLength(1);
    expect(model.rows.some((row) => row.kind === 'session')).toBe(false);
  });

  test('builds the folder-heavy 25,000-session projection without duplicating descendant storage', () => {
    const sessions = Array.from({ length: 25_000 }, (_, index) => node(`session-${index}`));
    const input = args([project([group(sessions)])]);
    input.foldersMap = {
      '/repo': Array.from({ length: 1_250 }, (_, folderIndex) => ({
        id: `folder-${folderIndex}`,
        name: `Folder ${folderIndex}`,
        createdAt: folderIndex,
        sessionIds: Array.from({ length: 20 }, (_, itemIndex) => `session-${folderIndex * 20 + itemIndex}`),
      })),
    };

    const model = buildSessionSidebarRowModel(input);

    expect(model.rows.filter((row) => row.kind === 'folder-header')).toHaveLength(1_250);
    expect(model.rows.filter((row) => row.kind === 'session')).toHaveLength(25_000);
    expect(model.selectionDescendantIds).toHaveLength(25_000);
    expect(model.rows).toHaveLength(26_251);
  });

  test('keeps normal activity state while search forces the same headers open', () => {
    const repeated = node('recent-match');
    const normal = args([]);
    normal.chatGroup = group([repeated], { id: 'managed-chats' });
    normal.collapsedActivities = new Set(['chats']);
    const normalModel = buildSessionSidebarRowModel(normal);

    const search = { ...normal, mode: 'search' as const, normalizedQuery: 'recent' };
    search.groupSearchDataByGroup = new WeakMap([[search.chatGroup!, {
      filteredNodes: [repeated], matchedSessionCount: 1, folderNameMatchCount: 0, groupMatches: false, hasMatch: true,
    }]]);
    const searchModel = buildSessionSidebarRowModel(search);

    expect(normalModel.rows.find((row) => row.kind === 'activity-header')).toMatchObject({ collapsed: true, forceExpanded: false });
    expect(searchModel.rows.find((row) => row.kind === 'activity-header')).toMatchObject({ collapsed: false, forceExpanded: true });
    expect(normal.collapsedActivities.has('chats')).toBe(true);
  });

  test('emits loading, failure, and permission status rows without treating them as empty success', () => {
    for (const state of ['loading', 'load-failed', 'permission-denied'] as const) {
      const main = group([]);
      const input = args([project([main])]);
      input.groupStatusByKey = new Map([['project-a:main', { state, directory: '/repo', canGrantAccess: state === 'permission-denied' }]]);
      expect(buildSessionSidebarRowModel(input).rows.some((row) => row.kind === 'status' && row.status.state === state)).toBe(true);
    }
  });

  test('resolves sticky identity from logical row ranges', () => {
    const first = project([group([node('a')])]);
    const second = { ...project([group([node('b')])]), project: { id: 'project-b', normalizedPath: '/repo-b' } };
    const model = buildSessionSidebarRowModel(args([first, second]));
    const secondHeader = model.stickyHeaders.find((header) => header.id === 'project-b');

    expect(secondHeader).toBeDefined();
    expect(resolveSessionSidebarStickyHeader(model.stickyHeaders, secondHeader?.rowIndex ?? 0)?.id).toBe('project-b');
  });

  test('timeline mode lists every root session flat, without children or project rows', () => {
    const input = args([project([group([node('project-session', [node('child')])])])]);
    input.viewMode = 'timeline';
    input.timelineItems = [timelineItem('a'), timelineItem('b')];

    const model = buildSessionSidebarRowModel(input);
    const sessions = model.rows.filter((row) => row.kind === 'session');

    expect(model.rows.some((row) => row.kind === 'project-header')).toBe(false);
    expect(model.rows.some((row) => row.kind === 'group-header')).toBe(false);
    expect(model.rows.find((row) => row.kind === 'activity-header')).toMatchObject({ activityKey: 'timeline' });
    expect(model.stickyHeaders.map((header) => header.id)).toEqual(['timeline']);
    expect(sessions.map((row) => row.node.session.id)).toEqual(['a', 'b']);
    expect(sessions.every((row) => row.renderContext === 'timeline' && row.depth === 0)).toBe(true);
    expect(model.rows.some((row) => row.kind === 'show-control')).toBe(false);
  });

  test('timeline mode reveals three chats and never counts pinned chats against that limit', () => {
    const chats = [node('pinned-1'), node('pinned-2'), ...Array.from({ length: 6 }, (_, index) => node(`chat-${index}`))];
    const input = args([]);
    input.viewMode = 'timeline';
    input.chatGroup = group(chats, { id: 'managed-chats' });
    input.pinnedSessionIds = pinnedIds('pinned-1', 'pinned-2');

    const model = buildSessionSidebarRowModel(input);
    const shown = model.rows.filter((row) => row.kind === 'session').map((row) => row.node.session.id);

    expect(shown).toContain('pinned-1');
    expect(shown).toContain('pinned-2');
    expect(shown.filter((id) => id.startsWith('chat-'))).toHaveLength(3);
    const control = model.rows.find((row) => row.kind === 'show-control');
    expect(control).toMatchObject({ control: 'more', currentCount: 3, increment: 7 });
  });

  test('timeline search counts one match per listed session', () => {
    const input = args([]);
    input.viewMode = 'timeline';
    input.mode = 'search';
    input.normalizedQuery = 'a';
    input.timelineItems = [timelineItem('a'), timelineItem('b')];

    expect(buildSessionSidebarRowModel(input).searchMatchCount).toBe(2);
  });

  test('timeline mode shows the sidebar empty row when nothing is listed', () => {
    const input = args([project([group([node('hidden-by-mode')])])]);
    input.viewMode = 'timeline';

    expect(buildSessionSidebarRowModel(input).rows).toMatchObject([{ kind: 'empty', emptyKind: 'sidebar' }]);
  });

  test('retains current session authority when presentation filters the row out', () => {
    const authoritative = project([group([node('hidden')])]);
    const input = args([]);
    input.authoritativeSections = [authoritative];

    expect(buildSessionSidebarRowModel(input).sessionById.get('hidden')?.id).toBe('hidden');
  });
});
