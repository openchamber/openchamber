import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionNode } from '../types';
import {
  appendSessionNodeRowEntries,
  buildActivityRowOrderEntries,
  buildSessionGroupRowModel,
  toSessionRowOrderIds,
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
      { id: 'parent', scopeKey: '/fallback', archived: false },
      { id: 'child', scopeKey: '/fallback', archived: false },
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
    expect(projectOut[0]).toEqual({ id: 'direct', scopeKey: 'project-a', archived: false });
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
      { id: 'parent', scopeKey: '/repo/worktree', archived: false },
      { id: 'child', scopeKey: '/repo/worktree', archived: false },
    ]);
  });
});

describe('buildSessionGroupRowModel', () => {
  const folderA: SessionRowOrderFolderEntry = {
    folder: { id: 'folder-a' },
    scopeDirectory: '/repo',
    nodes: [node('a1')],
  };
  const folderAChild: SessionRowOrderFolderEntry = {
    folder: { id: 'folder-a-child' },
    scopeDirectory: '/repo/worktree',
    nodes: [node('a1-child', [], null)],
  };
  const folderB: SessionRowOrderFolderEntry = {
    folder: { id: 'folder-b' },
    scopeDirectory: '/repo',
    nodes: [node('b1')],
  };
  const childFoldersByParentId = new Map([['folder-a', [folderAChild]]]);

  const build = (overrides: Partial<Parameters<typeof buildSessionGroupRowModel>[0]> = {}) =>
    buildSessionGroupRowModel({
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
  const itemIds = (model: ReturnType<typeof buildSessionGroupRowModel>): string[] =>
    model.items.map((item) => item.node.session.id);

  test('renders folder nodes before their child folders, then the ungrouped sessions', () => {
    expect(ids(build().entries)).toEqual(['a1', 'a1-child', 'b1', 'ungrouped']);
  });

  test('a collapsed group registers nothing', () => {
    expect(build({ isCollapsed: true }).entries).toEqual([]);
    expect(build({ isCollapsed: true }).items).toEqual([]);
  });

  test('a collapsed folder hides its own nodes and its whole child-folder subtree', () => {
    expect(ids(build({ collapsedFolderIds: new Set(['folder-a']) }).entries)).toEqual(['b1', 'ungrouped']);
  });

  test('an active search overrides folder collapse and node expansion', () => {
    expect(ids(build({
      hasSessionSearchQuery: true,
      collapsedFolderIds: new Set(['folder-a']),
      expandedParents: new Set(),
    }).entries)).toEqual(['a1', 'a1-child', 'b1', 'ungrouped']);
  });

  test('walks expanded ungrouped parents depth-first', () => {
    const grandchild = node('ungrouped-grandchild');
    const parent = node('ungrouped-parent', [grandchild]);

    expect(ids(build({
      visibleSessions: [parent, node('ungrouped-last')],
      expandedParents: new Set(['project:active:ungrouped-parent', 'project:active:ungrouped-grandchild']),
    }).entries)).toEqual(['a1', 'a1-child', 'b1', 'ungrouped-parent', 'ungrouped-grandchild', 'ungrouped-last']);
  });

  test('marks every entry of an archived bucket as archived', () => {
    const { entries } = build({ archivedBucket: true, projectId: null, groupDirectory: null });

    expect(entries.map((entry) => entry.archived)).toEqual([true, true, true, true]);
    expect(entries[0]?.scopeKey).toBe('/repo');
  });

  test('keeps duplicate session ids (recent and project copies both register)', () => {
    const duplicate: SessionRowOrderFolderEntry = {
      folder: { id: 'folder-duplicate' },
      scopeDirectory: '/repo',
      nodes: [node('ungrouped')],
    };

    expect(ids(build({ rootFolders: [duplicate] }).entries)).toEqual(['ungrouped', 'ungrouped']);
  });

  test('uses the folder worktree directory as the scope fallback', () => {
    const { entries } = build({ projectId: null, hasSessionSearchQuery: true });

    expect(entries[1]).toEqual({ id: 'a1-child', scopeKey: '/repo/worktree', archived: false });
  });

  test('collects entries and items with the same ids in order when the group has no folders', () => {
    const model = build({
      rootFolders: [],
      childFoldersByParentId: new Map(),
      visibleSessions: [node('first'), node('second')],
    });

    expect(ids(model.entries)).toEqual(['first', 'second']);
    expect(itemIds(model)).toEqual(ids(model.entries));
  });

  test('tracks the SessionTreeItem depth for nested chains under search', () => {
    const grandchild = node('grandchild');
    const child = node('child', [grandchild]);
    const root = node('root', [child]);
    const model = build({
      rootFolders: [],
      childFoldersByParentId: new Map(),
      visibleSessions: [root],
      hasSessionSearchQuery: true,
    });

    expect(model.items.map((item) => [item.node.session.id, item.depth])).toEqual([
      ['root', 0],
      ['child', 1],
      ['grandchild', 2],
    ]);
  });

  test('tracks depth through manual expansion without a search', () => {
    const child = node('child');
    const root = node('root', [child]);
    const model = build({
      rootFolders: [],
      childFoldersByParentId: new Map(),
      visibleSessions: [root],
      expandedParents: new Set(['project:active:root']),
    });

    expect(model.items.map((item) => [item.node.session.id, item.depth])).toEqual([
      ['root', 0],
      ['child', 1],
    ]);
  });

  test('flattens only the ungrouped region; folder rows keep normal flow', () => {
    const model = build();

    expect(ids(model.entries)).toEqual(['a1', 'a1-child', 'b1', 'ungrouped']);
    expect(itemIds(model)).toEqual(['ungrouped']);
  });

  test('keeps duplicate ids in the flattened items', () => {
    const model = build({
      rootFolders: [],
      childFoldersByParentId: new Map(),
      visibleSessions: [node('same'), node('same')],
    });

    expect(itemIds(model)).toEqual(['same', 'same']);
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

    expect(entries).toEqual([{ id: 'root', scopeKey: 'project-a', archived: false }]);
  });
});

describe('toSessionRowOrderIds', () => {
  test('preserves duplicates in order', () => {
    expect(toSessionRowOrderIds([
      { id: 'same', scopeKey: 'project-a', archived: false },
      { id: 'other', scopeKey: 'project-a', archived: false },
      { id: 'same', scopeKey: 'project-a', archived: false },
    ])).toEqual(['same', 'other', 'same']);
  });
});
