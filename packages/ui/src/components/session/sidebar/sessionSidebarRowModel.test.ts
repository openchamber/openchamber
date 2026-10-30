import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import type { SessionGroup, SessionNode } from './types';
import type { ProjectSection } from './projects/sessionProjectRender';
import { buildSessionSidebarRowModel, countSessionSearchMatches, resolveSessionSidebarStickyHeader, runExpansionKey, type SessionSidebarActivityItem, type SessionSidebarRowModelArgs, type SessionSidebarWorkEntry } from './sessionSidebarRowModel';
import { countSessionTreeQueryMatches } from './recent/activitySections';
import { buildMultiRunIndex } from '@/lib/multirun/runs';
import { withMultiRunMembership } from '@/lib/multirun/identity';
import { getPinnedSessionKey } from '@/lib/sessionPins';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { ensureChatsRootDirectory } from '@/lib/chatDirectories';
import { opencodeClient } from '@/lib/opencode/client';

const timelineItem = (id: string, overrides: Partial<SessionSidebarActivityItem> = {}): SessionSidebarActivityItem => ({
  node: { session: session(id), children: [], worktree: null },
  projectId: 'project-a',
  groupDirectory: '/repo',
  secondaryMeta: { projectLabel: 'repo', branchLabel: 'main' },
  ...overrides,
});

const sessionWorks = (items: SessionSidebarActivityItem[]): SessionSidebarWorkEntry[] => items.map((item) => ({ kind: 'session', item }));

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
  sessionOwnerById: new Map(),
  activeProjectId: 'project-a',
  singleProjectMode: false,
  singleProjectId: null,
  showOnlyMainWorkspace: false,
  hideDirectoryControls: false,
});

describe('buildSessionSidebarRowModel', () => {
  test('a Chats-only sidebar exposes an archived bucket with restore semantics and distinct row keys', () => {
    const active = node('active-chat');
    const archived = node('archived-chat');
    archived.session.time.archived = 3;
    const input = args([]);
    input.chatGroup = group([active], { id: 'managed-chats', draftTarget: 'chat' });
    input.archivedChatGroup = group([archived], { id: 'managed-chats-archived', label: 'Archived', isMain: false, isArchivedBucket: true, folderScopes: [] });
    const model = buildSessionSidebarRowModel(input);
    expect(model.rows.filter((row) => row.kind === 'group-header').map((row) => row.group.isArchivedBucket)).toEqual([true]);
    const sessions = model.rows.filter((row) => row.kind === 'session');
    expect(sessions.map((row) => [row.node.session.id, row.archived])).toEqual([['active-chat', false], ['archived-chat', true]]);
    expect(new Set(model.rows.map((row) => row.key)).size).toBe(model.rows.length);
    expect(model.sessionById.get('archived-chat')).toBe(archived.session);
    input.archivedChatGroup = null;
    expect(buildSessionSidebarRowModel(input).rows.filter((row) => row.kind === 'session').map((row) => row.node.session.id)).toEqual(['active-chat']);
  });

  test('keeps a cross-project child display-nested while folder actions use its own project', () => {
    const child = node('child');
    child.session.directory = '/project-b/worktree';
    const input = args([project([group([node('parent', [child])])])]);
    input.expandedParents = new Set(['project:active:parent']);
    input.sessionOwnerById = new Map([['child', {
      projectId: 'project-b',
      projectRoot: '/project-b',
      scopeDirectory: '/project-b/worktree',
      kind: 'worktree',
    }]]);

    const childRow = buildSessionSidebarRowModel(input).rows
      .find((row) => row.kind === 'session' && row.node.session.id === 'child');

    expect(childRow).toMatchObject({
      projectId: 'project-a',
      ownerProjectId: 'project-b',
      ownerKey: 'project-b',
      selectionScopeKey: 'project-b',
    });
  });

  test('gives an unresolved child no folder mutation owner from its display parent', () => {
    const child = node('unresolved-child');
    child.session.directory = '/outside-known-projects';
    const input = args([project([group([node('parent', [child])])])]);
    input.expandedParents = new Set(['project:active:parent']);
    input.sessionOwnerById = new Map([['parent', {
      projectId: 'project-a',
      projectRoot: '/repo',
      scopeDirectory: '/repo',
      kind: 'project',
    }]]);

    const model = buildSessionSidebarRowModel(input);
    const childRow = model.rows.find((row) => row.kind === 'session' && row.node.session.id === 'unresolved-child');

    expect(childRow).toMatchObject({ ownerProjectId: null, ownerKey: null, selectionScopeKey: null });
    expect(model.folderOwnerKeyBySessionId.has('unresolved-child')).toBe(false);
  });

  test('derives managed Chat folder ownership without a project owner record', () => {
    const chat = node('chat');
    chat.session.directory = '/home/.config/openchamber/chats/2026-10-26/session-chat';
    const input = args([]);
    input.chatGroup = group([chat], {
      id: 'managed-chats',
      directory: '/home/.config/openchamber/chats',
      folderScopeKey: '/home/.config/openchamber/chats',
    });

    const model = buildSessionSidebarRowModel(input);

    expect(model.folderOwnerKeyBySessionId.get('chat')).toBe('/home/.config/openchamber/chats');
  });

  test('does not give an outside child the managed Chat parent owner', () => {
    const child = node('outside-child');
    child.session.directory = '/outside-known-projects';
    const parent = node('chat-parent', [child]);
    parent.session.directory = '/home/.config/openchamber/chats/2026-10-26/session-parent';
    const input = args([]);
    input.chatGroup = group([parent], {
      id: 'managed-chats',
      directory: '/home/.config/openchamber/chats',
      folderScopeKey: '/home/.config/openchamber/chats',
    });
    input.expandedParents = new Set(['tree-chat:active:chat-parent']);

    const model = buildSessionSidebarRowModel(input);
    const childRow = model.rows.find((row) => row.kind === 'session' && row.node.session.id === 'outside-child');

    expect(model.folderOwnerKeyBySessionId.get('chat-parent')).toBe('/home/.config/openchamber/chats');
    expect(model.folderOwnerKeyBySessionId.has('outside-child')).toBe(false);
    expect(childRow).toMatchObject({ ownerProjectId: null, ownerKey: null, selectionScopeKey: null });
  });

  test('a session in work is in the top block and stays in its project group', () => {
    const working = node('working');
    const other = node('other');
    const input = args([project([group([working, other])])]);
    input.workEntries = sessionWorks([timelineItem('working')]);
    input.zoneSessionIds = new Set(['working']);

    const model = buildSessionSidebarRowModel(input);
    const sessionRows = model.rows.flatMap((row) => (row.kind === 'session' ? [`${row.renderContext}:${row.node.session.id}`] : []));

    expect(model.rows[0]).toMatchObject({ kind: 'activity-header', activityKey: 'work' });
    expect(sessionRows).toEqual(['mixed-compact:working', 'project:other', 'project:working']);
    expect(model.selectionEntries.filter((entry) => entry.id === 'working')).toHaveLength(2);
    expect(new Set(model.rows.map((row) => row.key)).size).toBe(model.rows.length);
  });

  test('detailed zone rows give the Tree view the two-line row', () => {
    const input = args([project([group([node('working')])])]);
    input.workEntries = sessionWorks([timelineItem('working')]);
    input.zoneSessionIds = new Set(['working']);
    input.detailedZoneRows = true;

    const rows = buildSessionSidebarRowModel(input).rows;
    const zoneRow = rows.find((row) => row.kind === 'session');

    expect(zoneRow?.kind === 'session' && zoneRow.renderContext).toBe('timeline-mixed');
  });

  // A detailed estimate on a row drawn in one line left a gap under every
  // chat once Detailed rows turned on.
  test('detailed zone rows leave Chats one line', () => {
    const input = args([]);
    input.chatGroup = group([node('chat')], { id: 'managed-chats' });
    input.detailedZoneRows = true;

    const chat = buildSessionSidebarRowModel(input).rows.find((row) => row.kind === 'session');

    expect(chat?.kind === 'session' && { context: chat.renderContext, detailed: chat.detailed, estimate: chat.estimateSize })
      .toEqual({ context: 'tree-chat', detailed: false, estimate: 32 });
  });

  test('Pinned opens above In work and its sessions stay in their project', () => {
    const input = args([project([group([node('pinned'), node('working')])])]);
    input.pinnedItems = [timelineItem('pinned')];
    input.workEntries = sessionWorks([timelineItem('working')]);
    input.zoneSessionIds = new Set(['pinned', 'working']);

    const rows = buildSessionSidebarRowModel(input).rows;
    const order = rows.flatMap((row) => (
      row.kind === 'activity-header' ? [row.activityKey]
        : row.kind === 'session' ? [`${row.renderContext}:${row.node.session.id}`]
          : []
    ));

    expect(order).toEqual(['pinned', 'mixed-compact:pinned', 'work', 'mixed-compact:working', 'project:pinned', 'project:working']);
  });

  test('search lists a pinned session once, in Pinned', () => {
    const pinnedNode = node('ses_pinned');
    const main = group([pinnedNode, node('ses_other')]);
    const input = args([project([main])]);
    input.mode = 'search';
    input.normalizedQuery = 'ses_pinned';
    input.groupSearchDataByGroup.set(main, {
      filteredNodes: [pinnedNode],
      matchedSessionCount: countSessionSearchMatches([pinnedNode], 'ses_pinned'),
      folderNameMatchCount: 0,
      groupMatches: false,
      hasMatch: true,
    });
    input.pinnedItems = [{ ...timelineItem('ses_pinned'), node: pinnedNode }];
    input.zoneSessionIds = new Set(['ses_pinned']);

    const model = buildSessionSidebarRowModel(input);

    expect(model.searchMatchCount).toBe(1);
    expect(model.rows.flatMap((row) => (row.kind === 'activity-header' ? [row.activityKey] : row.kind === 'project-header' ? ['project'] : []))).toEqual(['pinned']);
    expect(model.rows.filter((row) => row.kind === 'session')).toHaveLength(1);
  });

  test('a session in work stays in its folder', () => {
    const input = args([project([group([node('in-folder'), node('top-level')])])]);
    input.foldersMap = { '/repo': [{ id: 'outer', name: 'Outer', createdAt: 1, sessionIds: ['in-folder'] }] };
    input.workEntries = sessionWorks([timelineItem('in-folder')]);
    input.zoneSessionIds = new Set(['in-folder']);

    const rows = buildSessionSidebarRowModel(input).rows.filter((row) => row.kind === 'folder-header' || row.kind === 'session');

    expect(rows.map((row) => (row.kind === 'session' ? `${row.renderContext}:${row.node.session.id}` : row.displayName))).toEqual([
      'mixed-compact:in-folder', 'Outer', 'project:in-folder', 'project:top-level',
    ]);
  });

  test('search lists a session in work once, in the work block, and counts the tree once', () => {
    const parent = node('ses_parent', [node('ses_child'), node('ses_other')]);
    const main = group([parent]);
    const input = args([project([main])]);
    input.mode = 'search';
    input.normalizedQuery = 'ses_child';
    input.groupSearchDataByGroup.set(main, {
      filteredNodes: [parent],
      matchedSessionCount: countSessionSearchMatches([parent], 'ses_child'),
      folderNameMatchCount: 0,
      groupMatches: false,
      hasMatch: true,
    });
    input.workEntries = sessionWorks([{ ...timelineItem('ses_parent'), searchMatchCount: countSessionTreeQueryMatches(parent, 'ses_child') }]);
    input.zoneSessionIds = new Set(['ses_parent']);

    const model = buildSessionSidebarRowModel(input);
    const rows = model.rows.flatMap((row) => (row.kind === 'session' ? [row.node.session.id] : []));

    expect(model.searchMatchCount).toBe(1);
    expect(rows).toEqual(['ses_parent']);
    expect(model.selectionEntries.filter((entry) => entry.id === 'ses_parent')).toHaveLength(1);
  });

  test('rows carry guide lines for an open worktree and session', () => {
    const parent = node('parent', [node('child')]);
    const worktree = group([parent, node('last')], { id: 'wt', label: 'wt', isMain: false, directory: '/wt' });
    const input = args([project([group([node('root')]), worktree])]);
    input.expandedParents = new Set(['project:active:parent']);
    input.sessionOrderIndex = new Map([['root', 0], ['parent', 1], ['last', 2]]);
    const guidesOf = () => buildSessionSidebarRowModel(input).rows.flatMap((row) => (
      row.kind === 'session' ? [`${row.node.session.id}:${(row.treeGuides ?? []).map(({ level, end }) => `${level}${end ? '└' : '│'}`).join(' ')}`] : []
    ));

    expect(guidesOf()).toEqual(['root:', 'parent:1│', 'child:1│ 2└', 'last:1└']);
  });

  test('search counts a subsession of a session in work once, and the moved tree leaves its group', () => {
    const parent = node('ses_parent', [node('ses_child'), node('ses_other')]);
    const main = group([parent]);
    const input = args([project([main])]);
    input.mode = 'search';
    input.normalizedQuery = 'ses_child';
    input.groupSearchDataByGroup.set(main, {
      filteredNodes: [parent],
      matchedSessionCount: countSessionSearchMatches([parent], 'ses_child'),
      folderNameMatchCount: 0,
      groupMatches: false,
      hasMatch: true,
    });
    // As the sidebar builds it: the zone row drops its children and carries
    // the count of its whole tree.
    input.workEntries = sessionWorks([{ ...timelineItem('ses_parent'), searchMatchCount: countSessionTreeQueryMatches(parent, 'ses_child') }]);
    input.zoneSessionIds = new Set(['ses_parent']);

    const model = buildSessionSidebarRowModel(input);
    const rows = model.rows.flatMap((row) => (row.kind === 'session' ? [row.node.session.id] : []));

    expect(model.searchMatchCount).toBe(1);
    expect(rows).toEqual(['ses_parent']);
    // The project had no other match: no empty project header.
    expect(model.rows.some((row) => row.kind === 'project-header')).toBe(false);
  });

  test('search counts every matching subsession of a session in work', () => {
    const titled = (id: string, title: string, children: SessionNode[] = []): SessionNode => ({ session: { ...session(id), title }, children, worktree: null });
    const parent = titled('ses_parent', 'Parent', [titled('ses_a', 'fix header'), titled('ses_b', 'header spacing'), titled('ses_c', 'footer')]);
    const input = args([]);
    input.mode = 'search';
    input.normalizedQuery = 'header';
    input.workEntries = sessionWorks([{ ...timelineItem('ses_parent'), node: { ...parent, children: [] }, searchMatchCount: countSessionTreeQueryMatches(parent, 'header') }]);
    input.zoneSessionIds = new Set(['ses_parent']);

    expect(buildSessionSidebarRowModel(input).searchMatchCount).toBe(2);
  });

  test('in work sits under Chats and above the projects', () => {
    const working = node('working');
    const input = args([project([group([working, node('other')])])]);
    input.chatGroup = group([node('chat')], { id: 'chats', directory: '/chats', folderScopeKey: '/chats' });
    input.workEntries = sessionWorks([timelineItem('working')]);
    input.zoneSessionIds = new Set(['working']);

    const headers = buildSessionSidebarRowModel(input).rows.flatMap((row) => (
      row.kind === 'activity-header' ? [row.activityKey] : row.kind === 'project-header' ? [row.section.project.id] : []
    ));

    expect(headers).toEqual(['chats', 'work', 'project-a']);
  });

  test('no block while nothing is in work', () => {
    const input = args([project([group([node('other')])])]);
    input.workEntries = sessionWorks([]);
    const headers = buildSessionSidebarRowModel(input).rows.flatMap((row) => (row.kind === 'activity-header' ? [row.activityKey] : []));
    expect(headers).not.toContain('work');
  });

  test('uses occurrence keys while retaining duplicate session IDs in logical order', () => {
    const repeated = node('same-session');
    const input = args([project([group([repeated])])]);
    input.workEntries = sessionWorks([{ node: repeated, projectId: 'project-a', groupDirectory: '/repo', secondaryMeta: null }]);
    input.zoneSessionIds = new Set(['same-session']);

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

    expect(model.rows.filter((row) => row.kind === 'session')).toHaveLength(7);
    expect(model.rows.some((row) => row.kind === 'show-control' && row.more)).toBe(true);
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
      expect(model.rows.filter((row) => row.kind === 'session' && row.projectId === null)).toHaveLength(3);
      const control = model.rows.find((row) => row.kind === 'show-control' && row.containerKey === 'project-a:main');
      if (!control || control.kind !== 'show-control') throw new Error('Missing reveal control');
      expect(control.increment).toBe(20);
      // Show less joins Show more once a second batch shows, and Show more leaves once nothing is hidden.
      expect({ more: control.more, fewer: control.fewer }).toEqual({ more: count < 45, fewer: count > 20 });
      if (control.more) input.visibleCountByContainer = new Map([[control.containerKey, control.currentCount + control.increment]]);
      else input.visibleCountByContainer = new Map();
    }
    expect(buildSessionSidebarRowModel(input).rows.filter((row) => row.kind === 'session' && row.projectId === 'project-a')).toHaveLength(20);
  });

  test('Chats keep the tree slot', () => {
    const input = args([]);
    input.chatGroup = group(Array.from({ length: 5 }, (_, index) => node(`chat-${index}`)), { id: 'managed-chats' });
    const rows = buildSessionSidebarRowModel(input).rows;

    expect([...new Set(rows.flatMap((row) => (row.kind === 'session' ? [row.renderContext] : [])))]).toEqual(['tree-chat']);
    expect(rows.find((row) => row.kind === 'show-control')).toMatchObject({ flat: false });
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

  test('sessions inside a folder sit one level deeper than ungrouped sessions', () => {
    const child = node('child');
    child.session.parentID = 'in-folder';
    const input = args([project([group([node('in-folder', [child]), node('top-level')])])]);
    input.foldersMap = { '/repo': [
      { id: 'outer', name: 'Outer', createdAt: 1, sessionIds: [] },
      { id: 'inner', name: 'Inner', parentId: 'outer', createdAt: 1, sessionIds: ['in-folder'] },
    ] };
    input.expandedParents = new Set(['project:active:in-folder']);
    const rows = buildSessionSidebarRowModel(input).rows.filter((row) => row.kind === 'folder-header' || row.kind === 'session');

    expect(rows.map((row) => (row.kind === 'session' ? `${row.node.session.id}@${row.depth}` : row.displayName))).toEqual([
      'Outer', 'Outer / Inner', 'in-folder@1', 'child@2', 'top-level@0',
    ]);
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

  {
    test('Chats reveal three chats and never count pinned chats against that limit', () => {
      const chats = [node('pinned-1'), node('pinned-2'), ...Array.from({ length: 6 }, (_, index) => node(`chat-${index}`))];
      const input = args([]);
      input.chatGroup = group(chats, { id: 'managed-chats' });
      input.pinnedSessionIds = pinnedIds('pinned-1', 'pinned-2');

      const model = buildSessionSidebarRowModel(input);
      const shown = model.rows.filter((row) => row.kind === 'session').map((row) => row.node.session.id);

      expect(shown).toContain('pinned-1');
      expect(shown).toContain('pinned-2');
      expect(shown.filter((id) => id.startsWith('chat-'))).toHaveLength(3);
      const control = model.rows.find((row) => row.kind === 'show-control');
      expect(control).toMatchObject({ more: true, fewer: false, currentCount: 3, increment: 7 });
    });
  }

  test('pinned project sessions spend the reveal limit', () => {
    const nodes = [node('pinned-1'), node('pinned-2'), ...Array.from({ length: 8 }, (_, index) => node(`s${index}`))];
    const input = args([project([group(nodes)])]);
    input.pinnedSessionIds = pinnedIds('pinned-1', 'pinned-2');

    expect(buildSessionSidebarRowModel(input).rows.filter((row) => row.kind === 'session')).toHaveLength(7);
  });

  test('an empty worktree group is open whatever was saved, with no rows under it', () => {
    const worktree = group([], { id: 'worktree:/wt', label: 'feature', isMain: false, directory: '/wt', folderScopeKey: '/wt' });
    const input = args([project([group([node('root')]), worktree])]);
    input.collapsedGroups = new Set(['project-a:worktree:/wt']);

    const rows = buildSessionSidebarRowModel(input).rows;
    const header = rows.find((row) => row.kind === 'group-header');

    expect(header).toMatchObject({ empty: true, collapsed: false });
    expect(rows.at(-1)).toBe(header);
  });

  test('a worktree group with sessions keeps its saved collapse', () => {
    const worktree = group([node('wt-session')], { id: 'worktree:/wt', label: 'feature', isMain: false, directory: '/wt', folderScopeKey: '/wt' });
    const input = args([project([group([]), worktree])]);
    input.collapsedGroups = new Set(['project-a:worktree:/wt']);

    const rows = buildSessionSidebarRowModel(input).rows;

    expect(rows.find((row) => row.kind === 'group-header')).toMatchObject({ empty: false, collapsed: true });
    expect(rows.some((row) => row.kind === 'session')).toBe(false);
  });

  test('a folder keeps its saved collapse while its sessions are still loading', () => {
    const input = args([project([group([])])]);
    input.foldersMap = { '/repo': [{ id: 'outer', name: 'Outer', createdAt: 1, sessionIds: ['not-loaded-yet'] }] };
    input.collapsedFolders = new Set(['outer']);
    const folderRow = () => buildSessionSidebarRowModel(input).rows.find((row) => row.kind === 'folder-header');

    input.groupStatusByKey = new Map([['project-a:main', { state: 'loading', directory: null, canGrantAccess: false }]]);
    expect(folderRow()).toMatchObject({ empty: false, collapsed: true });

    input.groupStatusByKey = new Map([['project-a:main', { state: 'ready', directory: '/repo', canGrantAccess: false }]]);
    expect(folderRow()).toMatchObject({ empty: true, collapsed: false });
  });

  describe('works', () => {
    const worktree = (sessions: SessionNode[], id = 'wt') => group(sessions, {
      id: `worktree:/${id}`, label: id, branch: `feature/${id}`, isMain: false, directory: `/${id}`, folderScopeKey: `/${id}`,
      worktree: { path: `/${id}`, projectDirectory: '/repo', branch: `feature/${id}`, label: id },
    });
    const listedOf = (rows: ReturnType<typeof buildSessionSidebarRowModel>['rows']) => rows.flatMap((row) => (
      row.kind === 'activity-header' ? [`zone:${row.activityKey}`]
        : row.kind === 'project-header' ? [`project:${row.section.project.id}`]
          : row.kind === 'group-header' ? [`work:${row.group.id}@${row.depth}${row.mixed ? ':mixed' : ''}`]
            : row.kind === 'folder-header' ? [`folder:${row.displayName}`]
              : row.kind === 'session' ? [`${row.renderContext}:${row.node.session.id}@${row.depth}`]
                : []
    ));

    test('a worktree is listed among the project root works at the place of its latest session, spending one slot', () => {
      // Order: wt-new (in the worktree) is the most recent session, then root-a,
      // then wt-old (an older session in that worktree's tree), then root-b.
      const work = worktree([node('wt-old', [node('wt-new')])]);
      const roots = Array.from({ length: 8 }, (_, index) => node(`r${index}`));
      const input = args([project([group(roots), work])]);
      input.sessionOrderIndex = new Map([['r0', 0], ['wt-new', 1], ['wt-old', 9], ...roots.slice(1).map((root, index) => [root.session.id, index + 2] as const)]);
      input.collapsedGroups = new Set(['project-a:worktree:/wt']);

      const listed = listedOf(buildSessionSidebarRowModel(input).rows);
      expect(listed).toEqual([
        'project:project-a', 'project:r0@0', 'work:worktree:/wt@0',
        'project:r1@0', 'project:r2@0', 'project:r3@0', 'project:r4@0', 'project:r5@0',
      ]);
    });

    test('a space nobody has chatted in leads its project list, where an empty worktree closes it past Show more', () => {
      const space = group([], {
        id: 'space:0123456789ab', label: 'quick-falcon', isMain: false, directory: '/spaces/0123456789ab/repo', folderScopeKey: '/spaces/0123456789ab/repo',
        space: { id: '0123456789ab', name: 'quick-falcon', state: 'complete', projectDirectory: '/repo', directory: '/spaces/0123456789ab/repo' },
      });
      const roots = Array.from({ length: 8 }, (_, index) => node(`r${index}`));
      const input = args([project([group(roots), worktree([], 'empty'), space])]);
      input.sessionOrderIndex = new Map(roots.map((root, index) => [root.session.id, index] as const));
      input.liveSpaceIds = new Set(['0123456789ab']);

      const listed = listedOf(buildSessionSidebarRowModel(input).rows);
      expect(listed.slice(0, 3)).toEqual(['project:project-a', 'work:space:0123456789ab@0', 'project:r0@0']);
      expect(listed).not.toContain('work:worktree:/empty@0');

      // Failed or gone, it closes the list as an empty worktree does.
      input.liveSpaceIds = new Set();
      expect(listedOf(buildSessionSidebarRowModel(input).rows)).not.toContain('work:space:0123456789ab@0');
    });

    test('Detailed rows give the works under a project two lines, and keep what nests inside them on one', () => {
      const work = worktree([node('wt-1')]);
      const input = args([project([group([node('root', [node('child')])]), work])]);
      input.detailedZoneRows = true;
      input.expandedParents = new Set(['project:active:root']);
      input.draftsByGroupKey = new Map([
        ['project-a:main', [{ id: 'd1', directory: '/repo', projectId: 'project-a', text: 'next', mentions: [], attachments: [], createdAt: 1, updatedAt: 1 }]],
      ]);

      const detailedOf = buildSessionSidebarRowModel(input).rows.flatMap((row) => (
        row.kind === 'session' ? [`${row.node.session.id}:${row.detailed === true}`]
          : row.kind === 'draft' ? [`draft:${row.detailed}`]
            : row.kind === 'group-header' ? [`work:${row.detailed}`]
              : []
      ));
      expect(detailedOf).toEqual(['draft:true', 'root:true', 'child:false', 'work:true', 'wt-1:false']);
    });

    test('only the rows that are works of their own own their work', () => {
      const work = worktree([node('wt-1', [node('wt-child')])]);
      const input = args([project([group([node('root', [node('child')]), node('lane-1'), node('lane-2')]), work])]);
      input.runIndex = buildMultiRunIndex(['lane-1', 'lane-2'].map((id) => ({
        ...session(id),
        metadata: withMultiRunMembership({}, {
          version: 1, sessionID: id, group: { kind: 'id', id: '9f512893-6e63-4e49-a534-5de733ca103e' },
          groupSlug: 'fix-auth', role: 'run', providerID: 'anthropic', modelID: 'claude', title: 'Fix auth',
        }),
      })), () => '/repo');
      const runKey = [...input.runIndex.runs.keys()][0] ?? '';
      input.expandedParents = new Set(['mixed-compact:active:root', 'project:active:root', 'project:active:wt-1', runExpansionKey('project', runKey)]);
      input.workEntries = sessionWorks([timelineItem('root', { node: node('root', [node('child')]) })]);
      input.zoneSessionIds = new Set(['root', 'child']);

      const owners = buildSessionSidebarRowModel(input).rows.flatMap((row) => (
        row.kind === 'session' ? [`${row.renderContext}:${row.node.session.id}:${row.ownsWork}`] : []
      ));
      expect(owners).toEqual([
        'mixed-compact:root:true', 'mixed-compact:child:false',
        'project:lane-1:false', 'project:lane-2:false',
        'project:root:true', 'project:child:false',
        'project:wt-1:false', 'project:wt-child:false',
      ]);
    });

    test('a worktree stands where its archived sessions hold it', () => {
      const input = args([project([group([node('r0'), node('r1')]), worktree([node('wt-old')])])]);
      input.sessionOrderIndex = new Map([['r0', 0], ['r1', 1], ['wt-old', 2]]);
      input.worktreeArchiveAnchors = new Map([['project-a:worktree:/wt', 0.5]]);
      input.collapsedGroups = new Set(['project-a:worktree:/wt']);
      expect(listedOf(buildSessionSidebarRowModel(input).rows)).toEqual(['project:project-a', 'project:r0@0', 'work:worktree:/wt@0', 'project:r1@0']);
    });

    test('a pinned worktree is listed in Pinned after the pinned sessions, and leads its project while the section is hidden', () => {
      const pinnedWork = group([node('a1')], {
        id: 'worktree:/wt', label: 'wt', branch: 'feature/wt', isMain: false, directory: '/wt', folderScopeKey: '/wt',
        worktree: { path: '/wt', projectDirectory: '/repo', branch: 'feature/wt', label: 'wt', pinnedAt: 1 },
      });
      const input = args([project([group([node('r0'), node('pinned')]), pinnedWork])]);
      input.sessionOrderIndex = new Map([['r0', 0], ['a1', 1]]);
      input.collapsedGroups = new Set(['project-a:worktree:/wt']);
      input.pinnedItems = [timelineItem('pinned')];
      input.pinnedWorktrees = [{ kind: 'group', groupKey: 'project-a:worktree:/wt', projectId: 'project-a', group: pinnedWork }];
      input.movedSessionIds = new Set(['pinned']);
      input.movedGroupKeys = new Set(['project-a:worktree:/wt']);
      expect(listedOf(buildSessionSidebarRowModel(input).rows)).toEqual([
        'zone:pinned', 'mixed-compact:pinned@0', 'work:worktree:/wt@0:mixed', 'project:project-a', 'project:r0@0',
      ]);

      input.pinnedItems = [];
      input.pinnedWorktrees = [];
      input.movedSessionIds = new Set();
      input.movedGroupKeys = new Set();
      expect(listedOf(buildSessionSidebarRowModel(input).rows).slice(0, 3)).toEqual(['project:project-a', 'work:worktree:/wt@0', 'project:r0@0']);
    });

    test('a worktree with no session closes the project root list', () => {
      const input = args([project([group([node('root')]), worktree([])])]);
      input.sessionOrderIndex = new Map([['root', 0]]);
      expect(listedOf(buildSessionSidebarRowModel(input).rows)).toEqual(['project:project-a', 'project:root@0', 'work:worktree:/wt@0']);
    });

    test('a session work In work lists leaves its project when the collection moves it', () => {
      const input = args([project([group([node('working'), node('other')])])]);
      input.workEntries = sessionWorks([timelineItem('working')]);
      input.zoneSessionIds = new Set(['working']);
      input.movedSessionIds = new Set(['working']);

      expect(listedOf(buildSessionSidebarRowModel(input).rows)).toEqual([
        'zone:work', 'mixed-compact:working@0', 'project:project-a', 'project:other@0',
      ]);
    });

    test('a worktree work In work lists is its group row naming its project, out of the drag sort, and leaves its project', () => {
      const work = worktree([node('a1'), node('a2')]);
      const input = args([project([group([node('root')]), work])]);
      input.workEntries = [{ kind: 'group', groupKey: 'project-a:worktree:/wt', projectId: 'project-a', group: work }];
      input.movedGroupKeys = new Set(['project-a:worktree:/wt']);

      const model = buildSessionSidebarRowModel(input);
      expect(listedOf(model.rows)).toEqual([
        'zone:work', 'work:worktree:/wt@0:mixed', 'project:a1@1', 'project:a2@1', 'project:project-a', 'project:root@0',
      ]);
    });

    test('a worktree work kept in its project too keeps every row key unique and shares its collapse', () => {
      const work = worktree([node('a1')]);
      const input = args([project([group([]), work])]);
      input.workEntries = [{ kind: 'group', groupKey: 'project-a:worktree:/wt', projectId: 'project-a', group: work }];
      input.collapsedGroups = new Set(['project-a:worktree:/wt']);

      const model = buildSessionSidebarRowModel(input);
      const headers = model.rows.filter((row) => row.kind === 'group-header');
      expect(headers.map((row) => row.kind === 'group-header' && `${row.mixed}:${row.collapsed}`)).toEqual(['true:true', 'false:true']);
      expect(new Set(model.rows.map((row) => row.key)).size).toBe(model.rows.length);
    });

    test('the list by time lists the works of every project in one zone, without project headers', () => {
      const work = worktree([node('a1')]);
      const second: ProjectSection = { project: { id: 'project-b', normalizedPath: '/other' }, groups: [group([], { directory: '/other' })] };
      const input = args([project([group([node('root')]), work]), second]);
      input.pinnedItems = [timelineItem('pinned')];
      input.workEntries = sessionWorks([timelineItem('working')]);
      input.timeEntries = [
        { kind: 'session', item: timelineItem('b1', { projectId: 'project-b' }) },
        { kind: 'group', groupKey: 'project-a:worktree:/wt', projectId: 'project-a', group: work },
        { kind: 'session', item: timelineItem('root') },
      ];

      expect(listedOf(buildSessionSidebarRowModel(input).rows)).toEqual([
        'zone:pinned', 'mixed-compact:pinned@0', 'zone:work', 'mixed-compact:working@0',
        'zone:timeline', 'mixed-compact:b1@0', 'work:worktree:/wt@0:mixed', 'project:a1@1', 'mixed-compact:root@0',
      ]);

      input.collapsedActivities = new Set(['timeline']);
      expect(listedOf(buildSessionSidebarRowModel(input).rows).slice(-1)).toEqual(['zone:timeline']);
    });

    test('the list by time shows one line while sessions load and one per failed directory', () => {
      const second: ProjectSection = { project: { id: 'project-b', normalizedPath: '/other' }, groups: [group([], { directory: '/other' })] };
      const third: ProjectSection = { project: { id: 'project-c', normalizedPath: '/third' }, groups: [group([], { directory: '/third' })] };
      const input = args([project([group([])]), second, third]);
      input.timeEntries = [];
      input.groupStatusByKey = new Map([
        ['project-a:main', { state: 'loading' as const, directory: null, canGrantAccess: false }],
        ['project-b:main', { state: 'loading' as const, directory: null, canGrantAccess: false }],
        ['project-c:main', { state: 'load-failed' as const, directory: '/third', canGrantAccess: false }],
      ]);

      const statusesOf = () => buildSessionSidebarRowModel(input).rows.flatMap((row) => (row.kind === 'status' ? [`${row.status.state}:${row.groupKey}`] : []));
      expect(statusesOf()).toEqual(['loading:project-a:main', 'load-failed:project-c:main']);

      // A project with listed works needs no line, as under its own header.
      input.timeEntries = sessionWorks([timelineItem('a1')]);
      expect(statusesOf()).toEqual(['loading:project-b:main', 'load-failed:project-c:main']);
    });

    test('single-project mode keeps its project and picker whatever the grouping', () => {
      const input = args([project([group([node('root')])])]);
      input.singleProjectMode = true;
      input.singleProjectId = 'project-a';
      input.timeEntries = sessionWorks([timelineItem('root')]);

      expect(listedOf(buildSessionSidebarRowModel(input).rows)).toEqual(['project:project-a', 'project:root@0']);
    });

    test('a worktree filed into a folder of the project root renders inside it, and only there', () => {
      const work = worktree([node('a1')]);
      const input = args([project([group([node('root')]), work])]);
      input.foldersMap = { '/repo': [{ id: 'f', name: 'Releases', createdAt: 1, sessionIds: ['worktree:/wt'] }] };

      expect(listedOf(buildSessionSidebarRowModel(input).rows)).toEqual([
        'project:project-a', 'folder:Releases', 'work:worktree:/wt@1', 'project:a1@2', 'project:root@0',
      ]);

      // Folded away In work, the folder holds nothing of it.
      input.movedGroupKeys = new Set(['project-a:worktree:/wt']);
      input.workEntries = [{ kind: 'group', groupKey: 'project-a:worktree:/wt', projectId: 'project-a', group: work }];
      expect(listedOf(buildSessionSidebarRowModel(input).rows)).toEqual([
        'zone:work', 'work:worktree:/wt@0:mixed', 'project:a1@1', 'project:project-a', 'folder:Releases', 'project:root@0',
      ]);
    });
  });

  describe('multi-run rows', () => {
    const runMember = (id: string): Session => ({
      ...session(id),
      metadata: withMultiRunMembership({}, {
        version: 1, sessionID: id, group: { kind: 'id', id: '9f512893-6e63-4e49-a534-5de733ca103e' },
        groupSlug: 'fix-auth', role: 'run', providerID: 'anthropic', modelID: 'claude', title: 'Fix auth',
      }),
    });
    const runIndex = buildMultiRunIndex([runMember('lane-1'), runMember('lane-2')], () => '/repo');
    const runKey = [...runIndex.runs.keys()][0] ?? '';

    test('a run In work lists is one row even when a worktree work sits between its members', () => {
      const work = group([node('wt-1')], {
        id: 'worktree:/wt', label: 'wt', branch: 'feature/wt', isMain: false, directory: '/wt', folderScopeKey: '/wt',
        worktree: { path: '/wt', projectDirectory: '/repo', branch: 'feature/wt', label: 'wt' },
      });
      const input = args([project([group([node('lane-1'), node('lane-2')]), work])]);
      input.runIndex = runIndex;
      input.workEntries = [
        { kind: 'session', item: timelineItem('lane-1') },
        { kind: 'group', groupKey: 'project-a:worktree:/wt', projectId: 'project-a', group: work },
        { kind: 'session', item: timelineItem('lane-2') },
      ];
      input.movedSessionIds = new Set(['lane-1', 'lane-2']);
      input.movedGroupKeys = new Set(['project-a:worktree:/wt']);
      const runRows = buildSessionSidebarRowModel(input).rows.filter((row) => row.kind === 'run');
      expect(runRows).toHaveLength(1);
      expect(runRows[0]?.kind === 'run' && runRows[0].laneNodes.map((lane) => lane.session.id)).toEqual(['lane-1', 'lane-2']);
    });

    test('lanes collapse into one run row at the first lane, outside selection', () => {
      const input = args([project([group([node('lane-1'), node('other'), node('lane-2')])])]);
      input.runIndex = runIndex;
      const model = buildSessionSidebarRowModel(input);
      const listed = model.rows.flatMap((row) => (row.kind === 'run' ? [`run:${row.run.title}`] : row.kind === 'session' ? [row.node.session.id] : []));

      expect(listed).toEqual(['run:Fix auth', 'other']);
      expect(model.selectionEntries.map((entry) => entry.id)).toEqual(['other']);
    });

    test('an expanded run lists its lanes one level deeper', () => {
      const input = args([project([group([node('lane-1'), node('lane-2')])])]);
      input.runIndex = runIndex;
      input.expandedParents = new Set([runExpansionKey('project', runKey)]);
      const rows = buildSessionSidebarRowModel(input).rows.filter((row) => row.kind === 'run' || row.kind === 'session');

      expect(rows.map((row) => (row.kind === 'session' ? `${row.node.session.id}@${row.depth}` : `run@${row.depth}`))).toEqual(['run@0', 'lane-1@1', 'lane-2@1']);
    });

    test('a run inside a folder and its lanes sit one level deeper', () => {
      const input = args([project([group([node('lane-1'), node('lane-2')])])]);
      input.runIndex = runIndex;
      input.foldersMap = { '/repo': [{ id: 'folder-a', name: 'Folder', createdAt: 1, sessionIds: ['lane-1', 'lane-2'] }] };
      input.expandedParents = new Set([runExpansionKey('project', runKey)]);
      const rows = buildSessionSidebarRowModel(input).rows.filter((row) => row.kind === 'run' || row.kind === 'session');

      expect(rows.map((row) => (row.kind === 'session' ? `${row.node.session.id}@${row.depth}` : `run@${row.depth}`))).toEqual(['run@1', 'lane-1@2', 'lane-2@2']);
    });

    test('a run spends one slot of the reveal limit', () => {
      const nodes = [node('lane-1'), node('lane-2'), ...Array.from({ length: 7 }, (_, index) => node(`s${index}`))];
      const input = args([project([group(nodes)])]);
      input.runIndex = runIndex;
      const model = buildSessionSidebarRowModel(input);

      expect(model.rows.filter((row) => row.kind === 'run')).toHaveLength(1);
      expect(model.rows.filter((row) => row.kind === 'session')).toHaveLength(6);
    });

    test('an In work run row opens to its lanes as one-line rows and carries the sessions that block them', () => {
      const input = args([]);
      input.runIndex = runIndex;
      input.detailedZoneRows = true;
      input.workEntries = sessionWorks([
        timelineItem('lane-1', { blockingBadgeSessionScopes: [{ directory: '/repo', sessionIDs: ['lane-1', 'lane-1-child'] }] }),
        timelineItem('lane-2', { blockingBadgeSessionScopes: [{ directory: '/repo', sessionIDs: ['lane-2'] }] }),
      ]);
      input.zoneSessionIds = new Set(['lane-1', 'lane-2']);
      const run = buildSessionSidebarRowModel(input).rows.find((row) => row.kind === 'run');
      expect(run?.kind === 'run' && [...run.blockingSessionIds]).toEqual(['lane-1', 'lane-1-child', 'lane-2']);
      expect(run).toMatchObject({ detailed: true, expanded: false });

      input.expandedParents = new Set([runExpansionKey('timeline-mixed', runKey)]);
      const lanes = buildSessionSidebarRowModel(input).rows.flatMap((row) => (row.kind === 'session' ? [`${row.node.session.id}:${row.renderContext}`] : []));
      expect(lanes).toEqual(['lane-1:mixed-compact', 'lane-2:mixed-compact']);
    });

  });

  test('retains current session authority when presentation filters the row out', () => {
    const authoritative = project([group([node('hidden')])]);
    const input = args([]);
    input.authoritativeSections = [authoritative];

    expect(buildSessionSidebarRowModel(input).sessionById.get('hidden')?.id).toBe('hidden');
  });
});

const originalHomeInfo = opencodeClient.getFilesystemHomeInfo;
opencodeClient.getFilesystemHomeInfo = async () => ({
  home: '/home',
  canonicalChatsRoot: '/home/.config/openchamber/chats',
  canonicalLegacyChatsRoot: '/home/.config/openchamber/chats',
});
await ensureChatsRootDirectory();
opencodeClient.getFilesystemHomeInfo = originalHomeInfo;
