import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { buildSessionSidebarRowModel, type SessionSidebarBlock, type SessionSidebarRowModelArgs, type SessionSidebarWorkEntry } from './sessionSidebarRowModel';
import type { ProjectSection } from './projects/sessionProjectRender';
import type { DirectoryOwner } from './sessions/sessionOwnership';
import { getWorkFolderOwnerKey } from './sessions/sessionFolderIdentity';
import type { SessionGroup, SessionNode } from './types';

const session = (id: string, directory: string): Session => ({
  id, projectID: 'p', directory, title: id, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
});
const node = (id: string, directory = '/repo'): SessionNode => ({ session: session(id, directory), children: [], worktree: null });
const rootGroup = (sessions: SessionNode[]): SessionGroup => ({
  id: 'main', label: 'main', branch: null, description: null, isMain: true, worktree: null,
  directory: '/repo', folderScopeKey: '/repo', sessions,
});
const worktreeGroup = (sessions: SessionNode[]): SessionGroup => ({
  ...rootGroup(sessions), id: 'worktree:/wt', label: 'wt', branch: 'feature/wt', isMain: false, directory: '/wt', folderScopeKey: '/wt',
  worktree: { path: '/wt', projectDirectory: '/repo', branch: 'feature/wt', label: 'wt' },
});
const rootOwner: DirectoryOwner = { projectId: 'p', projectRoot: '/repo', scopeDirectory: '/repo', kind: 'project' };
const worktreeOwner: DirectoryOwner = { projectId: 'p', projectRoot: '/repo', scopeDirectory: '/wt', kind: 'worktree' };

const build = (overrides: Partial<SessionSidebarRowModelArgs>) => {
  const sections: ProjectSection[] = [{
    project: { id: 'p', normalizedPath: '/repo' },
    groups: [rootGroup([node('root')]), worktreeGroup([node('wt', '/wt')])],
  }];
  return buildSessionSidebarRowModel({
    mode: 'normal', sections, authoritativeSections: sections, chatGroup: null,
    foldersMap: { '/repo': [{ id: 'f', name: 'Folder', createdAt: 1, sessionIds: ['root'] }] },
    collapsedProjects: new Set(), collapsedGroups: new Set(),
    collapsedFolders: new Set(), collapsedActivities: new Set(), expandedParents: new Set(),
    visibleCountByContainer: new Map(), pinnedSessionIds: new Set(), sessionOrderIndex: new Map(), groupStatusByKey: new Map(),
    folderAuthorityByOwner: new Map([
      ['p', { scopeKeys: ['/repo'], complete: true }],
      [getWorkFolderOwnerKey('/wt'), { scopeKeys: ['/wt'], complete: true }],
    ]),
    sessionOwnerById: new Map([['root', rootOwner], ['wt', worktreeOwner]]),
    activeProjectId: 'p', singleProjectMode: false, singleProjectId: null, showOnlyMainWorkspace: false, hideDirectoryControls: false,
    ...overrides,
  });
};
const folderRow = (model: ReturnType<typeof build>) => {
  const row = model.rows.find((candidate) => candidate.kind === 'folder-header');
  if (row?.kind !== 'folder-header') throw new Error('No folder row');
  return row;
};
const sessionRow = (model: ReturnType<typeof build>, id: string) => {
  const row = model.rows.find((candidate) => candidate.kind === 'session' && candidate.node.session.id === id);
  if (row?.kind !== 'session') throw new Error(`No row for ${id}`);
  return row;
};

describe('sidebar folder ownership', () => {
  test('a worktree session owns only its worktree folders, and selects with its project', () => {
    const model = build({});
    expect(sessionRow(model, 'root').ownerKey).toBe('p');
    expect(sessionRow(model, 'wt').ownerKey).toBe(getWorkFolderOwnerKey('/wt'));
    expect(sessionRow(model, 'wt').selectionScopeKey).toBe('p');
    expect(model.folderOwnerKeyBySessionId.get('wt')).toBe(getWorkFolderOwnerKey('/wt'));
    expect(model.folderDropTargets.map((target) => target.ownerKey)).toEqual(['p']);
  });

  test('a folder inside a worktree takes that worktree\'s sessions', () => {
    const model = build({ foldersMap: { '/wt': [{ id: 'w', name: 'Old', createdAt: 1, sessionIds: [] }] } });
    expect(model.folderDropTargets.map(({ ownerKey, enabled }) => ({ ownerKey, enabled }))).toEqual([{ ownerKey: getWorkFolderOwnerKey('/wt'), enabled: true }]);
  });
});

describe('sidebar folders in the list by time', () => {
  const entry = (id: string): SessionSidebarWorkEntry => ({ kind: 'session', item: { node: node(id), projectId: 'p', groupDirectory: '/repo', secondaryMeta: null } });
  const summary = (model: ReturnType<typeof build>) => model.rows.flatMap((row) => {
    if (row.kind === 'activity-header') return [row.activityKey];
    if (row.kind === 'folder-header') return [`folder:${row.displayName}`];
    return row.kind === 'session' ? [row.node.session.id] : [];
  });

  test('folders lead the list and hold what is filed in them', () => {
    const model = build({ timeEntries: [entry('other')], foldersMap: { '/repo': [{ id: 'f', name: 'Folder', createdAt: 1, sessionIds: ['root'] }] } });
    expect(summary(model)).toEqual(['timeline', 'folder:Folder', 'root', 'other']);
  });

  test('a list holding only folders still shows, and a collapsed zone hides them', () => {
    expect(summary(build({ timeEntries: [] }))).toEqual(['timeline', 'folder:Folder', 'root']);
    expect(summary(build({ timeEntries: [], collapsedActivities: new Set(['timeline']) }))).toEqual(['timeline']);
  });

  test('a project a group of projects took keeps its folders there', () => {
    const blocks: SessionSidebarBlock[] = [{ kind: 'projects', excludedProjectIds: new Set(['p']) }];
    expect(summary(build({ timeEntries: [entry('other')], blocks }))).toEqual(['timeline', 'other']);
  });

  test('a collapsed zone with only folders hides the load statuses too', () => {
    const groupStatusByKey = new Map([['p:main', { state: 'loading' as const, directory: null, canGrantAccess: false }]]);
    expect(build({ timeEntries: [], groupStatusByKey }).rows.filter((row) => row.kind === 'status')).toHaveLength(1);
    const collapsed = build({ timeEntries: [], groupStatusByKey, collapsedActivities: new Set(['timeline']) });
    expect(collapsed.rows.filter((row) => row.kind === 'status')).toHaveLength(0);
  });

  test('a filed worktree sits in its folder', () => {
    const model = build({ timeEntries: [], foldersMap: { '/repo': [{ id: 'f', name: 'Folder', createdAt: 1, sessionIds: ['worktree:/wt'] }] } });
    expect(folderRow(model).memberCount).toBe(1);
    expect(model.rows.filter((row) => row.kind === 'group-header')).toHaveLength(1);
  });
});

describe('sidebar folder members', () => {
  test('a session a section took still counts, so the folder keeps its collapse', () => {
    const model = build({ movedSessionIds: new Set(['root']), collapsedFolders: new Set(['f']) });
    const row = folderRow(model);
    expect(row.empty).toBe(true);
    expect(row.memberCount).toBe(1);
  });

  test('a worktree a section took counts too', () => {
    const model = build({
      foldersMap: { '/repo': [{ id: 'f', name: 'Folder', createdAt: 1, sessionIds: ['worktree:/wt'] }] },
      movedGroupKeys: new Set(['p:worktree:/wt']),
    });
    expect(folderRow(model).memberCount).toBe(1);
  });

  test('a folder with nothing in it has no members', () => {
    const model = build({ foldersMap: { '/repo': [{ id: 'f', name: 'Folder', createdAt: 1, sessionIds: ['gone'] }] } });
    expect(folderRow(model).memberCount).toBe(0);
  });
});
