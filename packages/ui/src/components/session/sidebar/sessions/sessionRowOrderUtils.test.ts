import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionNode } from '../types';
import { getSessionFolderIdentityKey } from './sessionFolderIdentity';
import {
  appendSessionNodeRowEntries,
  buildActivityRowOrderEntries,
  buildActivitySessionRowKeys,
  buildSessionGroupRenderRowModel,
  buildSessionGroupRowOrderEntries,
  type SessionRowOrderEntry,
  type SessionRowOrderFolderEntry,
} from './sessionRowOrderUtils';

const makeSession = (id: string, directory: string | null = '/repo'): Session => ({
  id,
  slug: id,
  projectID: 'project',
  // SAFETY: Session.directory is typed as string, but sidebar rows treat it
  // defensively as nullable and these fixtures exercise the fallback branch.
  directory: directory as string,
  title: id,
  version: '1',
  time: { created: 1, updated: 1 },
});

const node = (id: string, children: SessionNode[] = [], directory: string | null = '/repo'): SessionNode => ({
  session: makeSession(id, directory),
  children,
  worktree: null,
});

const ids = (entries: readonly SessionRowOrderEntry[]): string[] => entries.map((entry) => entry.id);

describe('appendSessionNodeRowEntries', () => {
  const grandchild = node('grandchild');
  const child = node('child', [grandchild]);
  const root = node('root', [child]);

  const append = (expandedParents: Set<string>, hasSessionSearchQuery = false): SessionRowOrderEntry[] => {
    const out: SessionRowOrderEntry[] = [];
    appendSessionNodeRowEntries(out, [root], {
      projectId: 'project-a',
      fallbackDirectory: '/repo',
      renderContext: 'project',
      archived: false,
      hasSessionSearchQuery,
      expandedParents,
    });
    return out;
  };

  test('walks depth-first only through expanded nodes', () => {
    expect(ids(append(new Set()))).toEqual(['root']);
    expect(ids(append(new Set(['project:active:root'])))).toEqual(['root', 'child']);
    expect(ids(append(new Set(['project:active:root', 'project:active:child']))))
      .toEqual(['root', 'child', 'grandchild']);
  });

  test('forces every ancestor expanded while a search is active', () => {
    expect(ids(append(new Set(), true))).toEqual(['root', 'child', 'grandchild']);
  });

  test('keys archived and active buckets separately', () => {
    const appendArchived = (expandedParents: Set<string>): SessionRowOrderEntry[] => {
      const out: SessionRowOrderEntry[] = [];
      appendSessionNodeRowEntries(out, [root], {
        projectId: 'project-a',
        fallbackDirectory: '/repo',
        renderContext: 'project',
        archived: true,
        hasSessionSearchQuery: false,
        expandedParents,
      });
      return out;
    };

    expect(ids(appendArchived(new Set(['project:active:root'])))).toEqual(['root']);
    expect(ids(appendArchived(new Set(['project:archived:root'])))).toEqual(['root', 'child']);
  });

  test('keys recent rows under the recent context', () => {
    const out: SessionRowOrderEntry[] = [];
    appendSessionNodeRowEntries(out, [root], {
      projectId: null,
      fallbackDirectory: '/repo',
      renderContext: 'recent',
      archived: false,
      hasSessionSearchQuery: false,
      expandedParents: new Set(['project:active:root']),
    });
    expect(ids(out)).toEqual(['root']);

    const recentOut: SessionRowOrderEntry[] = [];
    appendSessionNodeRowEntries(recentOut, [root], {
      projectId: null,
      fallbackDirectory: '/repo',
      renderContext: 'recent',
      archived: false,
      hasSessionSearchQuery: false,
      expandedParents: new Set(['recent:active:root']),
    });
    expect(ids(recentOut)).toEqual(['root', 'child']);
  });

  test('resolves scope from project, then session directory, then the inherited fallback', () => {
    const childWithoutDirectory = node('child', [], null);
    const parent = node('parent', [childWithoutDirectory], null);
    const out: SessionRowOrderEntry[] = [];
    appendSessionNodeRowEntries(out, [parent], {
      projectId: null,
      fallbackDirectory: '/fallback',
      renderContext: 'project',
      archived: false,
      hasSessionSearchQuery: false,
      expandedParents: new Set(['project:active:parent']),
    });

    expect(out).toEqual([
      { id: 'parent', rowKey: 'project:active:/fallback:session:parent', scopeKey: '/fallback', archived: false },
      { id: 'child', rowKey: 'project:active:/fallback:session:parent/child:child', scopeKey: '/fallback', archived: false },
    ]);

    const projectOut: SessionRowOrderEntry[] = [];
    appendSessionNodeRowEntries(projectOut, [node('direct', [], '/elsewhere')], {
      projectId: 'project-a',
      fallbackDirectory: '/fallback',
      renderContext: 'project',
      archived: false,
      hasSessionSearchQuery: false,
      expandedParents: new Set(),
    });
    expect(projectOut[0]).toEqual({ id: 'direct', rowKey: 'project:active:/fallback:session:direct', scopeKey: 'project-a', archived: false });
  });

  test('normalizes directory scopes and inherits the parent directory for directory-less children', () => {
    const childWithoutDirectory = node('child', [], null);
    const parent = node('parent', [childWithoutDirectory], '/repo/worktree/');
    const out: SessionRowOrderEntry[] = [];
    appendSessionNodeRowEntries(out, [parent], {
      projectId: null,
      fallbackDirectory: '/fallback',
      renderContext: 'project',
      archived: false,
      hasSessionSearchQuery: false,
      expandedParents: new Set(['project:active:parent']),
    });

    expect(out).toEqual([
      { id: 'parent', rowKey: 'project:active:/fallback:session:parent', scopeKey: '/repo/worktree', archived: false },
      { id: 'child', rowKey: 'project:active:/fallback:session:parent/child:child', scopeKey: '/repo/worktree', archived: false },
    ]);
  });

  test('uses one explicit logical scope for managed-chat rows with dated directories', () => {
    const out: SessionRowOrderEntry[] = [];
    const chatsRoot = '/home/user/.config/openchamber/chats';
    const chatDirectory = `${chatsRoot}/2026-09-13/session-chat`;
    appendSessionNodeRowEntries(out, [node('chat', [node('chat-child', [], chatDirectory)], chatDirectory)], {
      projectId: null,
      fallbackDirectory: chatDirectory,
      selectionScopeKey: chatsRoot,
      renderContext: 'project',
      archived: false,
      hasSessionSearchQuery: true,
      expandedParents: new Set(),
    });

    expect(out.map((entry) => entry.scopeKey)).toEqual([chatsRoot, chatsRoot]);
  });
});

describe('buildSessionGroupRowOrderEntries', () => {
  const folderA: SessionRowOrderFolderEntry = {
    folder: { id: 'folder-a' },
    scopeKey: '/repo/worktree',
    scopeDirectory: '/repo/worktree',
    nodes: [node('a1')],
  };
  const folderAChild: SessionRowOrderFolderEntry = {
    folder: { id: 'folder-a-child' },
    scopeKey: '/repo/worktree',
    scopeDirectory: '/repo/worktree',
    nodes: [node('a1-child', [], null)],
  };
  const folderB: SessionRowOrderFolderEntry = {
    folder: { id: 'folder-b' },
    scopeKey: '/repo',
    scopeDirectory: '/repo',
    nodes: [node('b1')],
  };
  const childFoldersByParentId = new Map([[getSessionFolderIdentityKey('/repo/worktree', 'folder-a'), [folderAChild]]]);

  const build = (overrides: Partial<Parameters<typeof buildSessionGroupRowOrderEntries>[0]> = {}) =>
    buildSessionGroupRowOrderEntries({
      groupKey: 'project-a:group',
      isCollapsed: false,
      hasSessionSearchQuery: false,
      collapsedFolderIds: new Set(),
      expandedParents: new Set(),
      archivedBucket: false,
      projectId: 'project-a',
      groupDirectory: '/repo',
      rootFolders: [folderA, folderB],
      childFoldersByParentId,
      visibleSessions: [node('ungrouped')],
      ...overrides,
    });

  test('renders folder nodes before their child folders, then the ungrouped sessions', () => {
    expect(ids(build())).toEqual(['a1', 'a1-child', 'b1', 'ungrouped']);
  });

  test('a collapsed group registers nothing', () => {
    expect(build({ isCollapsed: true })).toEqual([]);
  });

  test('a collapsed folder hides its own nodes and its whole child-folder subtree', () => {
    expect(ids(build({ collapsedFolderIds: new Set([getSessionFolderIdentityKey('/repo/worktree', 'folder-a')]) }))).toEqual(['b1', 'ungrouped']);
  });

  test('scopes collapse when folder ids repeat across scopes', () => {
    const sameIdInProjectRoot: SessionRowOrderFolderEntry = {
      folder: { id: 'folder-a' },
      scopeKey: '/repo',
      scopeDirectory: '/repo',
      nodes: [node('project-root-session')],
    };

    expect(ids(build({
      rootFolders: [folderA, sameIdInProjectRoot],
      collapsedFolderIds: new Set([getSessionFolderIdentityKey('/repo/worktree', 'folder-a')]),
    }))).toEqual(['project-root-session', 'ungrouped']);
  });

  test('an active search overrides folder collapse and node expansion', () => {
    expect(ids(build({
      hasSessionSearchQuery: true,
      collapsedFolderIds: new Set(['folder-a']),
      expandedParents: new Set(),
    }))).toEqual(['a1', 'a1-child', 'b1', 'ungrouped']);
  });

  test('walks expanded ungrouped parents depth-first', () => {
    const grandchild = node('ungrouped-grandchild');
    const parent = node('ungrouped-parent', [grandchild]);

    expect(ids(build({
      visibleSessions: [parent, node('ungrouped-last')],
      expandedParents: new Set(['project:active:ungrouped-parent', 'project:active:ungrouped-grandchild']),
    }))).toEqual(['a1', 'a1-child', 'b1', 'ungrouped-parent', 'ungrouped-grandchild', 'ungrouped-last']);
  });

  test('marks every entry of an archived bucket as archived', () => {
    const entries = build({ archivedBucket: true, projectId: null, groupDirectory: null });

    expect(entries.map((entry) => entry.archived)).toEqual([true, true, true, true]);
    expect(entries[0]?.scopeKey).toBe('/repo');
  });

  test('keeps duplicate session ids (recent and project copies both register)', () => {
    const duplicate: SessionRowOrderFolderEntry = {
      folder: { id: 'folder-duplicate' },
      scopeKey: '/repo',
      scopeDirectory: '/repo',
      nodes: [node('ungrouped')],
    };

    const entries = build({ rootFolders: [duplicate] });
    expect(ids(entries)).toEqual(['ungrouped', 'ungrouped']);
    expect(entries[0]?.rowKey).not.toBe(entries[1]?.rowKey);
  });

  test('uses the folder worktree directory as the scope fallback', () => {
    const entries = build({ projectId: null, hasSessionSearchQuery: true });

    expect(entries[1]).toEqual({
      id: 'a1-child',
      rowKey: `project-a:group:folder:${getSessionFolderIdentityKey('/repo/worktree', 'folder-a-child')}:session:a1-child`,
      scopeKey: '/repo/worktree',
      archived: false,
    });
  });
});

describe('buildSessionGroupRenderRowModel', () => {
  const folderA: SessionRowOrderFolderEntry = {
    folder: { id: 'folder-a', name: 'Folder A', parentId: null },
    scopeKey: '/repo',
    scopeDirectory: '/repo',
    nodes: [node('folder-a-session')],
  };
  const folderAChild: SessionRowOrderFolderEntry = {
    folder: { id: 'folder-a-child', name: 'Child', parentId: 'folder-a' },
    scopeKey: '/repo',
    scopeDirectory: '/repo',
    nodes: [node('folder-child-session')],
  };
  const model = (overrides: Partial<Parameters<typeof buildSessionGroupRenderRowModel>[0]> = {}) => (
    buildSessionGroupRenderRowModel({
      groupKey: 'project-a:group',
      isCollapsed: false,
      hasSessionSearchQuery: false,
      collapsedFolderIds: new Set(),
      expandedParents: new Set(),
      archivedBucket: true,
      projectId: 'project-a',
      groupDirectory: '/repo',
      rootFolders: [folderA],
      childFoldersByParentId: new Map([
        [getSessionFolderIdentityKey('/repo', 'folder-a'), [folderAChild]],
      ]),
      visibleSessions: [node('ungrouped-session')],
      ...overrides,
    })
  );
  const rowLabels = (rows: ReturnType<typeof buildSessionGroupRenderRowModel>['rows']): string[] => rows.map((row) => {
    if (row.kind === 'folder-header') return `folder:${row.entry.folder.id}`;
    if (row.kind === 'folder-empty') return `empty:${row.entry.folder.id}`;
    return row.node.session.id;
  });

  test('places folder headers, folder occurrences, nested folders, and ungrouped rows in one order', () => {
    const result = model();

    expect(rowLabels(result.rows)).toEqual([
      'folder:folder-a',
      'folder-a-session',
      'folder:folder-a-child',
      'folder-child-session',
      'ungrouped-session',
    ]);
    expect(result.rows.filter((row) => row.kind === 'session').map((row) => row.key))
      .toEqual(result.entries.map((entry) => entry.rowKey));
  });

  test('uses the scoped folder identity for folder row containers', () => {
    const result = model({ useCanonicalFolderRowKeys: true });
    const expectedRowKey = `project-a:group:folder:${getSessionFolderIdentityKey('/repo', 'folder-a')}:session:folder-a-session`;

    expect(result.rows[1]?.key).toBe(expectedRowKey);
    expect(result.entries[0]?.rowKey).toBe(expectedRowKey);
  });

  test('keeps established archived virtual folder occurrence keys', () => {
    const result = model();

    expect(result.rows[1]?.key).toBe('project-a:group:folder:/repo:folder-a:session:folder-a-session');
    expect(result.entries[0]?.rowKey).toBe(result.rows[1]?.key);
  });

  test('flattens expanded descendants into the same model with stable occurrence keys', () => {
    const parent = node('parent', [node('child')]);
    const result = model({
      rootFolders: [],
      childFoldersByParentId: new Map(),
      visibleSessions: [parent],
      expandedParents: new Set(['project:archived:parent']),
    });

    expect(rowLabels(result.rows)).toEqual(['parent', 'child']);
    expect(result.rows[0]?.kind).toBe('session');
    expect(result.rows[1]?.kind).toBe('session');
    if (result.rows[0]?.kind === 'session' && result.rows[1]?.kind === 'session') {
      expect(result.rows[0].key).toBe('project-a:group:session:parent');
      expect(result.rows[1].key).toBe('project-a:group:session:parent/child:child');
      expect(result.rows[1].depth).toBe(1);
    }
  });

  test('keeps a collapsed folder header while hiding its body and descendants', () => {
    const result = model({
      collapsedFolderIds: new Set([getSessionFolderIdentityKey('/repo', 'folder-a')]),
      visibleSessions: [],
    });

    expect(rowLabels(result.rows)).toEqual(['folder:folder-a']);
    expect(result.entries).toEqual([]);
  });

  test('represents an expanded empty folder body without mounting session rows', () => {
    const emptyFolder: SessionRowOrderFolderEntry = {
      folder: { id: 'empty', name: 'Empty', parentId: null },
      scopeKey: '/repo',
      scopeDirectory: '/repo',
      nodes: [],
    };
    const result = model({
      rootFolders: [emptyFolder],
      childFoldersByParentId: new Map(),
      visibleSessions: [],
    });

    expect(rowLabels(result.rows)).toEqual(['folder:empty', 'empty:empty']);
    expect(result.entries).toEqual([]);
  });

  test('does not duplicate malformed cyclic folder components', () => {
    const cycleA: SessionRowOrderFolderEntry = {
      folder: { id: 'cycle-a', name: 'Cycle A', parentId: 'cycle-b' },
      scopeKey: '/repo',
      scopeDirectory: '/repo',
      nodes: [node('cycle-a-session')],
    };
    const cycleB: SessionRowOrderFolderEntry = {
      folder: { id: 'cycle-b', name: 'Cycle B', parentId: 'cycle-a' },
      scopeKey: '/repo',
      scopeDirectory: '/repo',
      nodes: [node('cycle-b-session')],
    };
    const result = model({
      rootFolders: [cycleA],
      childFoldersByParentId: new Map([
        [getSessionFolderIdentityKey('/repo', 'cycle-a'), [cycleB]],
        [getSessionFolderIdentityKey('/repo', 'cycle-b'), [cycleA]],
      ]),
      visibleSessions: [],
    });

    expect(rowLabels(result.rows)).toEqual([
      'folder:cycle-a',
      'cycle-a-session',
      'folder:cycle-b',
      'cycle-b-session',
    ]);
  });
});

describe('buildActivityRowOrderEntries', () => {
  const item = (id: string, children: SessionNode[] = [], directory: string | null = '/repo') => ({
    node: node(id, children, directory),
    projectId: 'project-a',
    groupDirectory: directory,
  });

  test('slices to the visible limit and keeps document order', () => {
    const entries = buildActivityRowOrderEntries(
      [item('first'), item('second'), item('third')],
      { visibleLimit: 2, hasSessionSearchQuery: false, expandedParents: new Set() },
    );

    expect(ids(entries)).toEqual(['first', 'second']);
  });

  test('expands recent rows through the recent expansion keys', () => {
    const child = node('child');
    const entries = buildActivityRowOrderEntries(
      [item('root', [child])],
      { visibleLimit: 7, hasSessionSearchQuery: false, expandedParents: new Set(['recent:active:root']) },
    );

    expect(ids(entries)).toEqual(['root', 'child']);
  });

  test('never marks recent entries archived', () => {
    const entries = buildActivityRowOrderEntries(
      [item('root')],
      { visibleLimit: 7, hasSessionSearchQuery: false, expandedParents: new Set() },
    );

    expect(entries).toEqual([{
      id: 'root',
      rowKey: 'activity:active-now:root:0:session:root',
      scopeKey: 'project-a',
      archived: false,
    }]);
  });

  test('assigns distinct row keys to duplicate Recent occurrences', () => {
    const duplicate = node('duplicate');
    const items = [item('duplicate'), { ...item('duplicate'), node: duplicate }];
    const entries = buildActivityRowOrderEntries(
      items,
      { visibleLimit: 7, hasSessionSearchQuery: false, expandedParents: new Set(), sectionKey: 'active-now' },
    );

    expect(entries.map((entry) => entry.id)).toEqual(['duplicate', 'duplicate']);
    expect(entries[0]?.rowKey).not.toBe(entries[1]?.rowKey);
    expect(entries.map((entry) => entry.rowKey)).toEqual(buildActivitySessionRowKeys(items, {
      visibleLimit: 7,
      sectionKey: 'active-now',
    }));
  });
});
