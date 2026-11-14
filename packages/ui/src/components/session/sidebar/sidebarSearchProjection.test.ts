import { expect, test } from 'bun:test';
import { ACTIVE_SEARCH_INITIAL, buildSessionSidebarRowModel, type SessionSidebarRow } from './sessionSidebarRowModel';
import { searchFixture, searchResult } from './sidebarSearch.fixture';
import { resolveSidebarSearchScope, sidebarSearchMetadata } from './sidebarConversationSearch';
import type { WorktreeMetadata } from '@/types/worktree';

const TREE_ROW_KINDS: ReadonlySet<SessionSidebarRow['kind']> = new Set([
  'activity-header', 'project-header', 'caption', 'group-header', 'folder-header', 'session', 'run', 'draft', 'show-control', 'status',
]);
const describeRow = (row: SessionSidebarRow): string => (
  row.kind === 'search-result' ? row.result.sessionId : row.kind === 'search-show-more' ? `more:${row.hidden}` : row.kind
);
const archivedResults = (count: number) => Array.from({ length: count }, (_, index) => searchResult(`old-${index}`, { archived: true, metadata: null }));

test('a search lists active results in rank order whatever project owns them', () => {
  const input = searchFixture();
  input.contentSearchResults = [searchResult('b-0', { directory: '/repo/b' }), searchResult('unowned', { metadata: null, directory: '/unknown' }), searchResult('a-0')];

  const model = buildSessionSidebarRowModel(input);

  expect(model.rows.map(describeRow)).toEqual(['b-0', 'unowned', 'a-0']);
  expect(model.search).toBe(true);
  expect(model.searchMatchCount).toBe(3);
});

test('a search draws no tree rows, with sessions, zones and custom sections present', () => {
  const input = searchFixture(4);
  const node = input.sections[0]!.groups[0]!.sessions[0]!;
  const item = { node, projectId: 'a', groupDirectory: '/repo/a', secondaryMeta: null };
  input.chatGroup = { ...input.sections[0]!.groups[0]!, id: 'managed-chats', directory: '/chats', folderScopeKey: '/chats' };
  input.pinnedItems = [item];
  input.workEntries = [{ kind: 'session', item }];
  input.blocks = [{ kind: 'chats' }, { kind: 'pinned' }, { kind: 'work' }, { kind: 'custom', id: 'mine', name: 'Mine', entries: [{ kind: 'session', item }], hideWhenEmpty: false, preview: false }, { kind: 'projects' }];
  input.contentSearchResults = [searchResult('a-0')];

  const model = buildSessionSidebarRowModel(input);

  expect(model.rows.filter((row) => TREE_ROW_KINDS.has(row.kind))).toEqual([]);
  expect(model.rows.map(describeRow)).toEqual(['a-0']);
  expect(model.stickyHeaders).toEqual([]);
  // The same input lists its tree while browsing.
  expect(buildSessionSidebarRowModel({ ...input, mode: 'normal' }).rows.some((row) => row.kind === 'session')).toBe(true);
});

test('a conversation found only by its messages is listed like any other', () => {
  const input = searchFixture();
  input.contentSearchResults = [
    searchResult('a-0'),
    searchResult('by-message', { metadata: null, titleRanges: [], excerpt: { messageId: 'm', role: 'user', snippet: 'a needle', createdAt: 1 } }),
  ];

  const rows = buildSessionSidebarRowModel(input).rows;

  expect(rows.map((row) => row.kind)).toEqual(['search-result', 'search-result']);
  expect(rows[1]).toMatchObject({ kind: 'search-result', key: 'search-result:by-message', result: { excerpt: { messageId: 'm' } } });
  // The excerpt takes a second line.
  expect(rows[1]!.estimateSize).toBeGreaterThan(rows[0]!.estimateSize);
});

test('archived results follow the active ones under a caption, all of them', () => {
  const input = searchFixture();
  const archived = archivedResults(8);
  // Rank mixes the two; the list keeps each group's own rank order.
  input.contentSearchResults = [archived[0]!, searchResult('a-0'), ...archived.slice(1), searchResult('b-0', { directory: '/repo/b' })];

  const model = buildSessionSidebarRowModel(input);

  expect(model.rows.map(describeRow)).toEqual(['a-0', 'b-0', 'search-archived-caption', 'old-0', 'old-1', 'old-2', 'old-3', 'old-4', 'old-5', 'old-6', 'old-7']);
  // Bulk selection covers what is listed, with each row's lifecycle.
  expect(model.selectionEntries.map((entry) => [entry.id, entry.archived])).toEqual([
    ['a-0', false], ['b-0', false], ...archived.map((result) => [result.sessionId, true]),
  ]);
  expect(model.searchMatchCount).toBe(10);
  // The caption holds at the top while its matches scroll under it.
  expect(model.stickyHeaders).toEqual([{ rowIndex: 2, kind: 'search', id: 'archived' }]);
});

test('no archived results need no caption', () => {
  const input = searchFixture();
  input.contentSearchResults = [searchResult('a-0')];
  expect(buildSessionSidebarRowModel(input).rows.map(describeRow)).toEqual(['a-0']);
});

test('each block ends with its own pager', () => {
  const input = searchFixture();
  input.contentSearchResults = [searchResult('a-0'), ...archivedResults(2)];
  input.searchSectionsWithMore = new Set(['active', 'archived']);

  const rows = buildSessionSidebarRowModel(input).rows;
  expect(rows.map(describeRow)).toEqual(['a-0', 'search-more', 'search-archived-caption', 'old-0', 'old-1', 'search-more']);
  expect(rows.flatMap((row) => (row.kind === 'search-more' ? [row.section] : []))).toEqual(['active', 'archived']);
});

test('archived matches still to ask for keep the caption and the pager with no row to show', () => {
  const input = searchFixture();
  input.contentSearchResults = [searchResult('a-0')];
  input.searchSectionsWithMore = new Set(['archived']);

  expect(buildSessionSidebarRowModel(input).rows.map(describeRow)).toEqual(['a-0', 'search-archived-caption', 'search-more']);
});

test('a finished search with no results says so, and an unfinished one never claims empty', () => {
  const input = searchFixture();
  input.contentSearchResults = [];
  expect(buildSessionSidebarRowModel(input).rows).toMatchObject([{ kind: 'empty', emptyKind: 'search' }]);

  input.searchIncomplete = true;
  expect(buildSessionSidebarRowModel(input).rows).toEqual([]);
  input.searchSectionsWithMore = new Set(['active']);
  expect(buildSessionSidebarRowModel(input).rows.map((row) => row.kind)).toEqual(['search-more']);
});

test('every result names its project, a worktree result its branch too', () => {
  const input = searchFixture();
  const worktree: WorktreeMetadata = { path: '/wt/feature', projectDirectory: '/repo/a', branch: 'feature/search', label: 'feature' };
  input.contentSearchResults = [searchResult('a-0'), searchResult('a-wt', { directory: '/wt/feature' })];
  input.searchLocationById = new Map([
    ['a-0', { projectId: 'a', groupDirectory: '/repo/a', projectLabel: 'a', branchLabel: 'main', inSpace: false, worktree: null }],
    ['a-wt', { projectId: 'a', groupDirectory: '/wt/feature', projectLabel: 'a', branchLabel: 'feature/search', inSpace: false, worktree }],
  ]);
  input.searchProjectById = new Map([['a', { id: 'a', label: 'A' }]]);

  const model = buildSessionSidebarRowModel(input);

  expect(model.rows[0]).toMatchObject({ context: { project: { id: 'a', label: 'A' }, branchLabel: 'main' } });
  expect(model.rows[1]).toMatchObject({ context: { project: { id: 'a', label: 'A' }, branchLabel: 'feature/search' } });
  expect(model.selectionEntries.map((entry) => entry.scopeKey)).toEqual(['a', 'a']);
});

test('a result in a space names the space in place of a branch', () => {
  const input = searchFixture();
  input.contentSearchResults = [searchResult('a-0')];
  input.searchLocationById = new Map([['a-0', {
    projectId: 'a', groupDirectory: '/spaces/space-a', projectLabel: 'a', branchLabel: 'Review space', inSpace: true, worktree: null,
  }]]);
  input.searchProjectById = new Map([['a', { id: 'a', label: 'A' }]]);

  expect(buildSessionSidebarRowModel(input).rows[0]).toMatchObject({
    context: { project: { id: 'a', label: 'A' }, folderLabel: null, branchLabel: null, worktreeFolder: null, spaceLabel: 'Review space' },
  });
});

test('a deleted worktree shows its folder when no branch is known', () => {
  const input = searchFixture();
  input.contentSearchResults = [searchResult('deleted-worktree', { metadata: null, directory: '/deleted/worktrees/fix-search' })];
  input.searchLocationById = new Map([['deleted-worktree', {
    projectId: 'a', groupDirectory: '/repo/a', projectLabel: 'a', branchLabel: null, inSpace: false, worktree: { path: '/deleted/worktrees/fix-search', projectDirectory: '/repo/a', branch: '', label: 'fix-search' },
  }]]);
  input.searchProjectById = new Map([['a', { id: 'a', label: 'A' }]]);

  expect(buildSessionSidebarRowModel(input).rows[0]).toMatchObject({
    context: { project: { id: 'a', label: 'A' }, folderLabel: null, branchLabel: null, worktreeFolder: 'fix-search', spaceLabel: null },
  });
});

test('an unregistered folder shows its name, and a chat or a result with no folder shows nothing', () => {
  const input = searchFixture();
  input.homeDirectory = '/Users/me';
  input.contentSearchResults = [
    searchResult('unowned', { metadata: null, directory: '/unknown' }),
    searchResult('chat', { metadata: null, directory: '/Users/me/.config/openchamber/chats/2026-01/chat' }),
    searchResult('no-folder', { metadata: null, directory: null }),
  ];
  const none = { project: null, folderLabel: null, branchLabel: null, worktreeFolder: null, spaceLabel: null };

  const model = buildSessionSidebarRowModel(input);

  expect(model.rows[0]).toMatchObject({ context: { ...none, folderLabel: 'unknown' } });
  expect(model.rows[1]).toMatchObject({ context: none });
  expect(model.rows[2]).toMatchObject({ context: none });
  expect(model.selectionEntries.map((entry) => entry.scopeKey)).toEqual([null, null, null]);
});

const scopeProjects = [{ id: 'a', normalizedPath: '/repo/a', label: 'a' }, { id: 'b', normalizedPath: '/repo/b', label: 'b' }];
const scopeWorktree: WorktreeMetadata = { path: '/external/topic', branch: 'topic', label: 'Topic work', projectDirectory: '/repo/a' };

test('search admits known directories and any folder under a project or one of its worktrees', () => {
  const scope = resolveSidebarSearchScope({
    projects: scopeProjects, worktrees: new Map([['/repo/a', [scopeWorktree]]]), knownDirectories: new Set(['/repo/a', '/chats/2026-01/chat']), isVSCode: false,
  });

  expect(scope.available).toBe(true);
  // Every directory: the content request names none.
  expect(scope.directories).toBeUndefined();
  expect(scope.isAdmitted('/chats/2026-01/chat')).toBe(true);
  expect(scope.isAdmitted('/repo/a')).toBe(true);
  expect(scope.isAdmitted('/repo/b')).toBe(true);
  expect(scope.isAdmitted('/repo/b/packages/ui')).toBe(true);
  expect(scope.isAdmitted('/external/topic')).toBe(true);
  expect(scope.isAdmitted('/external/topic/packages/ui')).toBe(true);
  expect(scope.isAdmitted('/repo/a/')).toBe(true);
});

test('search leaves out unknown directories, siblings that only share a prefix, and no directory', () => {
  const scope = resolveSidebarSearchScope({
    projects: scopeProjects, worktrees: new Map([['/repo/a', [scopeWorktree]]]), knownDirectories: new Set(['/repo/a']), isVSCode: false,
  });

  expect(scope.isAdmitted('/unknown')).toBe(false);
  expect(scope.isAdmitted('/repo')).toBe(false);
  expect(scope.isAdmitted('/repo/a-old')).toBe(false);
  expect(scope.isAdmitted('/external/topic-old')).toBe(false);
  expect(scope.isAdmitted('/chats/2026-01/chat')).toBe(false);
  expect(scope.isAdmitted(null)).toBe(false);
});

test('VS Code keeps to its workspace directories and sends them with the request', () => {
  const scope = resolveSidebarSearchScope({
    projects: scopeProjects, worktrees: new Map([['/repo/a', [scopeWorktree]]]), knownDirectories: new Set(['/repo/b', '/repo/a']), isVSCode: true,
  });

  expect(scope.available).toBe(true);
  expect(scope.directories).toEqual(['/repo/a', '/repo/b']);
  expect(scope.isAdmitted('/repo/a')).toBe(true);
  expect(scope.isAdmitted('/repo/a/child')).toBe(false);
  expect(scope.isAdmitted('/external/topic')).toBe(false);
});

test('VS Code with no workspace directory has no search, never a search of everything', () => {
  const scope = resolveSidebarSearchScope({ projects: scopeProjects, worktrees: new Map(), knownDirectories: new Set(), isVSCode: true });

  expect(scope.available).toBe(false);
  expect(scope.directories).toEqual([]);
  expect(scope.isAdmitted('/repo/a')).toBe(false);
});

test('search metadata lists admitted conversations once, active and archived', () => {
  const fixture = searchFixture(4);
  const sessions = fixture.sections.flatMap((section) => section.groups.flatMap((group) => group.sessions.map((node) => node.session)));
  sessions[1]!.time.archived = 2;

  const metadata = sidebarSearchMetadata({
    sessions: [...sessions, sessions[0]!], isAdmitted: (directory) => directory === '/repo/a', owners: fixture.sessionOwnerById,
    projects: fixture.sections.map((section) => section.project), worktrees: new Map(),
  });

  expect(metadata.map((item) => [item.sessionId, item.archived])).toEqual([['a-0', false], ['a-1', true]]);
  expect(metadata[0]).toMatchObject({ projectLabel: 'a', worktreeLabel: null, directory: '/repo/a' });
});

test('search metadata names the worktree branch from the path-keyed worktree map', () => {
  const fixture = searchFixture(2);
  const session = fixture.sections[0]!.groups[0]!.sessions[0]!.session;
  const worktree: WorktreeMetadata = { path: '/repo/a', projectDirectory: '/repo/a', branch: 'feature/a', label: 'a' };

  const metadata = sidebarSearchMetadata({ sessions: [session], isAdmitted: () => true, owners: fixture.sessionOwnerById,
    projects: fixture.sections.map((section) => section.project), worktrees: new Map([['/repo/a', [worktree]]]) });

  expect(metadata[0]?.worktreeLabel).toBe('feature/a');
});

test('active matches past the first batch wait behind Show more, apart from the archived block', () => {
  const input = searchFixture();
  const active = Array.from({ length: ACTIVE_SEARCH_INITIAL + 4 }, (_, index) => searchResult(`live-${index}`, { metadata: null }));
  input.contentSearchResults = [...active, ...archivedResults(1)];

  const rows = buildSessionSidebarRowModel(input).rows.map(describeRow);
  expect(rows.slice(0, ACTIVE_SEARCH_INITIAL)).toEqual(active.slice(0, ACTIVE_SEARCH_INITIAL).map((result) => result.sessionId));
  expect(rows.slice(ACTIVE_SEARCH_INITIAL)).toEqual(['more:4', 'search-archived-caption', 'old-0']);

  input.revealedSearchSections = new Set(['active']);
  expect(buildSessionSidebarRowModel(input).rows.filter((row) => row.kind === 'search-result')).toHaveLength(ACTIVE_SEARCH_INITIAL + 5);
});

test('what a session started is not a conversation to find', () => {
  const metadata = sidebarSearchMetadata({
    sessions: [
      { id: 'root', title: 'Parent', directory: '/repo/a', time: { created: 1, updated: 2 } },
      { id: 'child', title: 'verify AGENTS.md', directory: '/repo/a', parentID: 'root', time: { created: 1, updated: 2 } },
    ] as never,
    isAdmitted: () => true, owners: new Map(), projects: [], worktrees: new Map(),
  });
  expect(metadata.map((item) => [item.sessionId, item.updatedAt])).toEqual([['root', 2]]);
});
