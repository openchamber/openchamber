import { expect, test } from 'bun:test';
import { buildSessionSidebarRowModel } from './sessionSidebarRowModel';
import { searchFixture, searchResult } from './sidebarSearch.fixture';
import { projectSidebarSearchGroups, resolveSidebarSearchScope, sidebarSearchMetadata } from './sidebarConversationSearch';
import { parseOmniQuery, setOmniFlag } from '@/lib/search/omniQuery';
import type { WorktreeMetadata } from '@/types/worktree';

test('metadata rows retain highlight ranges and merge a content excerpt without duplication', () => {
  const input = searchFixture();
  input.contentSearchResults = [searchResult('a-0', { excerpt: { messageId: 'exact-message', role: 'user', snippet: 'A needle', createdAt: 1 }, moreMatches: 2 })];
  const model = buildSessionSidebarRowModel(input);
  const matches = model.rows.filter((row) => row.kind === 'session' && row.node.session.id === 'a-0');
  expect(matches).toHaveLength(1);
  expect(matches[0]).toMatchObject({ searchResult: { titleRanges: [[0, 6]], excerpt: { messageId: 'exact-message' }, moreMatches: 2 } });
});

test('content-only results stay between their owning project caption and the next project', () => {
  const input = searchFixture();
  input.contentSearchResults = [searchResult('content-a', { metadata: null })];
  const rows = buildSessionSidebarRowModel(input).rows;
  expect(rows.map((row) => row.kind === 'project-header' ? row.section.project.id : row.kind === 'search-result' ? row.result.sessionId : null).filter(Boolean)).toEqual(['a', 'content-a', 'b']);
});

test('a content-only project with zero title matches still has its caption', () => {
  const input = searchFixture();
  for (const section of input.sections) for (const group of section.groups) input.groupSearchDataByGroup.set(group, { filteredNodes: [], matchedSessionCount: 0, folderNameMatchCount: 0, groupMatches: false, hasMatch: false });
  input.contentSearchResults = [searchResult('content-b', { metadata: null, directory: '/repo/b' })];
  expect(buildSessionSidebarRowModel(input).rows.map((row) => row.kind === 'project-header' ? row.section.project.id : row.kind === 'search-result' ? row.result.sessionId : row.kind)).toEqual(['b', 'content-b']);
});

test('an admitted result with no known owner gets Chats and never a guessed project', () => {
  const input = searchFixture();
  input.contentSearchResults = [searchResult('unowned', { metadata: null, directory: '/unknown' })];
  const rows = buildSessionSidebarRowModel(input).rows;
  const index = rows.findIndex((row) => row.kind === 'search-result');
  expect(rows[index - 1]).toMatchObject({ kind: 'activity-header', activityKey: 'chats' });
  expect(rows[index]).toMatchObject({ context: { project: null, folderLabel: 'unknown', branchLabel: null, worktreeFolder: null, spaceLabel: null } });
});

test('search context omits its project under that project header and keeps the branch', () => {
  const input = searchFixture();
  input.contentSearchResults = [searchResult('a-0')];
  input.searchLocationById = new Map([['a-0', {
    projectId: 'a', groupDirectory: '/repo/a', projectLabel: 'a', branchLabel: 'feature/search', inSpace: false, worktree: null,
  }]]);
  input.searchProjectById = new Map([['a', { id: 'a', label: 'A' }]]);

  const row = buildSessionSidebarRowModel(input).rows.find((candidate) => candidate.kind === 'session' && candidate.node.session.id === 'a-0');

  expect(row).toMatchObject({ context: { project: null, folderLabel: null, branchLabel: 'feature/search', worktreeFolder: null, spaceLabel: null } });
});

test('under its own worktree header a search row drops the branch the header already names', () => {
  const input = searchFixture();
  const rootGroup = input.sections[0]!.groups[0]!;
  const worktree = { path: '/wt/feature', projectDirectory: '/repo/a', branch: 'feature/search', label: 'feature' };
  const node = { ...rootGroup.sessions[0]!, session: { ...rootGroup.sessions[0]!.session, id: 'a-wt', directory: '/wt/feature' } };
  const worktreeGroup = { ...rootGroup, id: 'feature', label: 'feature/search', branch: 'feature/search', isMain: false, worktree, directory: '/wt/feature', folderScopeKey: '/wt/feature', sessions: [node] };
  input.sections[0]!.groups.push(worktreeGroup);
  input.groupSearchDataByGroup.set(worktreeGroup, { filteredNodes: [node], matchedSessionCount: 1, folderNameMatchCount: 0, groupMatches: false, hasMatch: true });
  input.contentSearchResults = [searchResult('a-0'), searchResult('a-wt', { directory: '/wt/feature' })];
  input.searchLocationById = new Map([
    ['a-0', { projectId: 'a', groupDirectory: '/repo/a', projectLabel: 'a', branchLabel: 'main', inSpace: false, worktree: null }],
    ['a-wt', { projectId: 'a', groupDirectory: '/wt/feature', projectLabel: 'a', branchLabel: 'feature/search', inSpace: false, worktree }],
  ]);
  input.searchProjectById = new Map([['a', { id: 'a', label: 'A' }]]);

  const rows = buildSessionSidebarRowModel(input).rows;
  const contextOf = (id: string) => rows.find((row) => row.kind === 'session' && row.node.session.id === id);

  expect(contextOf('a-wt')).toMatchObject({ context: { project: null, branchLabel: null, worktreeFolder: null, spaceLabel: null } });
  expect(contextOf('a-0')).toMatchObject({ context: { project: null, branchLabel: 'main' } });
});

test('zone search rows retain their project and use a space name in place of the branch', () => {
  const input = searchFixture();
  const node = input.sections[0]!.groups[0]!.sessions[0]!;
  input.contentSearchResults = [searchResult('a-0')];
  input.pinnedItems = [{ node, projectId: 'a', groupDirectory: '/repo/a', secondaryMeta: null }];
  input.zoneSessionIds = new Set(['a-0']);
  input.searchLocationById = new Map([['a-0', {
    projectId: 'a', groupDirectory: '/spaces/space-a', projectLabel: 'a', branchLabel: 'Review space', inSpace: true, worktree: null,
  }]]);
  input.searchProjectById = new Map([['a', { id: 'a', label: 'A' }]]);

  const row = buildSessionSidebarRowModel(input).rows.find((candidate) => candidate.kind === 'session' && candidate.node.session.id === 'a-0');

  expect(row).toMatchObject({ context: { project: { id: 'a', label: 'A' }, folderLabel: null, branchLabel: null, worktreeFolder: null, spaceLabel: 'Review space' } });
});

test('a result with no folder gets no context, and a bare title row keeps its 40px estimate', () => {
  const input = searchFixture();
  input.contentSearchResults = [searchResult('no-folder', { metadata: null, directory: null, excerpt: null })];
  const row = buildSessionSidebarRowModel(input).rows.find((candidate) => candidate.kind === 'search-result');
  expect(row).toMatchObject({ context: { project: null, folderLabel: null, branchLabel: null, worktreeFolder: null, spaceLabel: null }, estimateSize: 40 });
});

test('a search row under the only shown project keeps that project when no header is drawn', () => {
  const input = searchFixture();
  input.showOnlyMainWorkspace = true;
  input.contentSearchResults = [searchResult('a-0', { metadata: null, excerpt: null })];
  input.searchLocationById = new Map([['a-0', {
    projectId: 'a', groupDirectory: '/repo/a', projectLabel: 'a', branchLabel: 'feature/search', inSpace: false, worktree: null,
  }]]);
  input.searchProjectById = new Map([['a', { id: 'a', label: 'A' }]]);
  const rows = buildSessionSidebarRowModel(input).rows;
  const row = rows.find((candidate) => candidate.kind === 'session' && candidate.node.session.id === 'a-0');
  expect(rows.some((candidate) => candidate.kind === 'project-header')).toBe(false);
  expect(row).toMatchObject({ context: { project: { id: 'a', label: 'A' }, branchLabel: 'feature/search' }, estimateSize: 56 });
});

test('deleted worktrees show their folder when no branch is available', () => {
  const input = searchFixture();
  input.contentSearchResults = [searchResult('deleted-worktree', { metadata: null, directory: '/deleted/worktrees/fix-search' })];
  input.searchLocationById = new Map([['deleted-worktree', {
    projectId: 'a', groupDirectory: '/repo/a', projectLabel: 'a', branchLabel: null, inSpace: false, worktree: { path: '/deleted/worktrees/fix-search', projectDirectory: '/repo/a', branch: '', label: 'fix-search' },
  }]]);
  input.searchProjectById = new Map([['a', { id: 'a', label: 'A' }]]);

  const row = buildSessionSidebarRowModel(input).rows.find((candidate) => candidate.kind === 'search-result');

  expect(row).toMatchObject({ context: { project: null, folderLabel: null, branchLabel: null, worktreeFolder: 'fix-search', spaceLabel: null } });
});

test('chats-root results have no search context', () => {
  const input = searchFixture();
  input.homeDirectory = '/Users/me';
  input.contentSearchResults = [searchResult('chat', { metadata: null, directory: '/Users/me/.config/openchamber/chats/2026-01/chat' })];

  const row = buildSessionSidebarRowModel(input).rows.find((candidate) => candidate.kind === 'search-result');

  expect(row).toMatchObject({ context: { project: null, folderLabel: null, branchLabel: null, worktreeFolder: null, spaceLabel: null } });
});

test('the Chats fallback remains present when browsing hid its block', () => {
  const input = searchFixture();
  input.blocks = [{ kind: 'projects' }];
  input.contentSearchResults = [searchResult('unowned', { metadata: null, directory: '/unknown', archived: true })];
  const model = buildSessionSidebarRowModel(input);
  expect(model.rows[0]).toMatchObject({ kind: 'activity-header', activityKey: 'chats' });
  expect(model.selectionEntries.find((entry) => entry.id === 'unowned')).toMatchObject({ archived: true, scopeKey: null });
});

test('content matches participate in keyboard order and the projected count', () => {
  const input = searchFixture();
  input.contentSearchResults = [searchResult('a-0'), searchResult('content-b', { metadata: null, directory: '/repo/b' })];
  const model = buildSessionSidebarRowModel(input);
  expect(model.selectionEntries.map((entry) => entry.id)).toContain('content-b');
  expect(model.searchMatchCount).toBe(2);
  expect(model.rows.some((row) => row.kind === 'empty')).toBe(false);
});

test('a rejected first page retains its pager and incomplete search never claims empty', () => {
  const input = searchFixture(0);
  input.contentSearchResults = [];
  input.searchIncomplete = true;
  expect(buildSessionSidebarRowModel(input).rows).toEqual([]);
  input.hasMoreSearchResults = true;
  expect(buildSessionSidebarRowModel(input).rows.map((row) => row.kind)).toEqual(['search-more']);
});

for (const lifecycle of ['active', 'archived', 'all'] as const) test(`${lifecycle} metadata admission includes only matching lifecycle and admitted directories`, () => {
  const fixture = searchFixture(4);
  const sessions = fixture.sections.flatMap((section) => section.groups.flatMap((group) => group.sessions.map((node) => node.session)));
  sessions[1]!.time.archived = 2;
  sessions[3]!.time.archived = 2;
  const metadata = sidebarSearchMetadata({ sessions, lifecycle, isAdmitted: (directory) => directory === '/repo/a', owners: fixture.sessionOwnerById, projects: fixture.sections.map((section) => section.project), worktrees: new Map() });
  expect(metadata.map((item) => item.sessionId)).toEqual(lifecycle === 'all' ? ['a-0', 'a-1'] : lifecycle === 'archived' ? ['a-1'] : ['a-0']);
});

test('typed and menu flags resolve identical exact scopes including out-of-tree worktrees', () => {
  const fixture = searchFixture();
  const worktree: WorktreeMetadata = { path: '/external/topic', branch: 'topic', label: 'Topic work', projectDirectory: '/repo/a' };
  const base = { activeProjectId: 'a', projects: fixture.sections.map((section) => section.project), worktrees: new Map([['/repo/a', [worktree]]]), knownDirectories: new Set(['/repo/a', '/repo/b', '/external/topic']), owners: fixture.sessionOwnerById, sessions: [], isVSCode: false };
  const typed = parseOmniQuery('needle project:a worktree:topic');
  const menu = parseOmniQuery(setOmniFlag(setOmniFlag('needle', 'project', 'a'), 'worktree', '/external/topic'));
  for (const query of [typed, menu]) {
    const scope = resolveSidebarSearchScope({ ...base, filters: query.filters });
    expect(scope.directories).toEqual(['/external/topic']);
    expect(scope.isAdmitted('/external/topic')).toBe(true);
    expect(scope.isAdmitted('/repo/a')).toBe(false);
  }
  expect(resolveSidebarSearchScope({ ...base, filters: { project: 'current' } }).directories).toEqual(['/external/topic', '/repo/a']);
  expect(resolveSidebarSearchScope({ ...base, filters: { project: '/repo/b' } }).directories).toEqual(['/repo/b']);
  expect(resolveSidebarSearchScope({ ...base, filters: { project: '/repo/b/' } }).directories).toEqual(['/repo/b']);
  const missing = resolveSidebarSearchScope({ ...base, filters: { worktree: 'missing' } });
  expect(missing.available).toBe(false);
  expect(missing.directories).toEqual([]);
  expect(missing.isAdmitted('/repo/a')).toBe(false);
});

test('VS Code exact workspace admission rejects nested and out-of-workspace directories', () => {
  const fixture = searchFixture();
  const scope = resolveSidebarSearchScope({ filters: {}, activeProjectId: 'a', projects: fixture.sections.map((section) => section.project), worktrees: new Map(), knownDirectories: new Set(['/repo/a']), owners: fixture.sessionOwnerById, sessions: [], isVSCode: true });
  expect(scope.directories).toEqual(['/repo/a']);
  expect(scope.isAdmitted('/repo/a')).toBe(true);
  expect(scope.isAdmitted('/repo/a/child')).toBe(false);
  expect(scope.isAdmitted('/repo/b')).toBe(false);
});

test('content-aware group projection keeps ancestors and excludes unrelated sessions', () => {
  const fixture = searchFixture(4);
  const group = fixture.sections[0]!.groups[0]!;
  group.sessions[0]!.children = [group.sessions[1]!];
  group.sessions = [group.sessions[0]!];
  const data = projectSidebarSearchGroups([group], new Set(['a-1'])).get(group)!;
  expect(data.filteredNodes.map((node) => node.session.id)).toEqual(['a-0']);
  expect(data.filteredNodes[0]!.children.map((node) => node.session.id)).toEqual(['a-1']);
  expect(projectSidebarSearchGroups([group], new Set(['other'])).get(group)!.filteredNodes).toEqual([]);
});

test('a project none of whose titles match keeps its conversation that matched by its messages', () => {
  const input = searchFixture(2);
  input.sections = [];
  input.groupSearchDataByGroup = new WeakMap();
  input.contentSearchResults = [searchResult('a-0', { metadata: null, excerpt: { messageId: 'm', role: 'user', snippet: 'needle', createdAt: 1 } })];

  const rows = buildSessionSidebarRowModel(input).rows;

  expect(rows.some((row) => row.kind === 'project-header' && row.section.project.id === 'a')).toBe(true);
  expect(rows.some((row) => row.kind === 'search-result' && row.result.sessionId === 'a-0')).toBe(true);
});

test('a worktree filter finds the project worktrees by the project path, not its id', () => {
  const project = { id: 'path_encoded', normalizedPath: '/repo/root', label: 'root' };
  const worktree: WorktreeMetadata = { path: '/outside/tree', projectDirectory: '/repo/root', branch: 'feature/tree', label: 'tree' };

  const scope = resolveSidebarSearchScope({
    filters: { project: '/repo/root', worktree: '/outside/tree' }, activeProjectId: project.id, projects: [project],
    worktrees: new Map([['/repo/root', [worktree]]]), knownDirectories: new Set(['/repo/root', '/outside/tree']),
    owners: new Map(), sessions: [], isVSCode: false,
  });

  expect(scope.directories).toEqual(['/outside/tree']);
  expect(scope.isAdmitted('/outside/tree')).toBe(true);
});

test('a project found only by its messages keeps its place in the project order', () => {
  const input = searchFixture(2);
  input.sections = [input.sections[1]!];
  input.contentSearchResults = [searchResult('a-0', { metadata: null, excerpt: { messageId: 'm', role: 'user', snippet: 'needle', createdAt: 1 } }), searchResult('b-0')];

  const headers = buildSessionSidebarRowModel(input).rows.flatMap((row) => row.kind === 'project-header' ? [row.section.project.id] : []);

  expect(headers).toEqual(['a', 'b']);
});

test('result metadata names the worktree branch from the path-keyed worktree map', () => {
  const fixture = searchFixture(2);
  const session = fixture.sections[0]!.groups[0]!.sessions[0]!.session;
  const worktree: WorktreeMetadata = { path: '/repo/a', projectDirectory: '/repo/a', branch: 'feature/a', label: 'a' };

  const metadata = sidebarSearchMetadata({ sessions: [session], lifecycle: 'all', isAdmitted: () => true, owners: fixture.sessionOwnerById,
    projects: fixture.sections.map((section) => section.project), worktrees: new Map([['/repo/a', [worktree]]]) });

  expect(metadata[0]?.worktreeLabel).toBe('feature/a');
});

test('a worktree path scope leaves out a sibling worktree whose path starts the same', () => {
  const fixture = searchFixture();
  const worktrees: WorktreeMetadata[] = [
    { path: '/worktrees/task', branch: 'task', label: 'task', projectDirectory: '/repo/a' },
    { path: '/worktrees/task-old', branch: 'task-old', label: 'task-old', projectDirectory: '/repo/a' },
  ];
  const scope = resolveSidebarSearchScope({ filters: { worktree: '/worktrees/task' }, activeProjectId: 'a', projects: fixture.sections.map((section) => section.project), worktrees: new Map([['/repo/a', worktrees]]), knownDirectories: new Set(['/repo/a', '/worktrees/task', '/worktrees/task-old']), owners: fixture.sessionOwnerById, sessions: [], isVSCode: false });
  expect(scope.directories).toEqual(['/worktrees/task']);
  expect(scope.isAdmitted('/worktrees/task-old')).toBe(false);
});
