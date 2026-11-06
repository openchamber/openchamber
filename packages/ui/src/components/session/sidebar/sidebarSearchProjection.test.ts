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
  expect(rows[index]).toMatchObject({ projectLabel: null });
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
  const base = { activeProjectId: 'a', projects: fixture.sections.map((section) => section.project), worktrees: new Map([['a', [worktree]]]), knownDirectories: new Set(['/repo/a', '/repo/b', '/external/topic']), owners: fixture.sessionOwnerById, sessions: [], isVSCode: false };
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
