import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { resolveSelectionFolderScopes } from './useSidebarBulkActions';
import {
  deriveSessionRowBulkSelectAll,
  deriveSessionRowSelectionArchived,
  deriveSessionRowSelectionScope,
  type SessionRowOrderEntry,
} from '../sessions/sessionRowOrderUtils';
import { getProjectFolderScopesFromTopology } from '../sessions/sessionFolderIdentity';
import type { SessionGroup } from '../types';

const sessionMetadata = (id: string, archived: boolean): Session => ({
  id,
  slug: id,
  projectID: 'project-a',
  title: id,
  version: '1',
  directory: '/workspace/project-a',
  time: archived
    ? { created: 1, updated: 1, archived: 2 }
    : { created: 1, updated: 1 },
});

const folderScopeGroup = (overrides: Partial<SessionGroup>): SessionGroup => ({
  id: 'root',
  label: '',
  branch: null,
  description: null,
  isMain: true,
  worktree: null,
  directory: '/workspace/project-a',
  folderScopeKey: '/workspace/project-a',
  sessions: [],
  ...overrides,
});

describe('sidebar bulk project scopes', () => {
  const projectTopology = [{
    project: { id: 'project-a', normalizedPath: '/workspace/project-a' },
    groups: [
      folderScopeGroup({
        folderScopes: [{ scopeKey: '/workspace/project-a', directory: '/workspace/project-a' }],
      }),
      folderScopeGroup({
        id: 'worktree',
        isMain: false,
        directory: '/workspace/project-a-worktree',
        folderScopeKey: '/workspace/project-a-worktree',
      }),
      folderScopeGroup({
        id: 'archived',
        isMain: false,
        isArchivedBucket: true,
        directory: null,
        folderScopeKey: '/workspace/project-a/.archived',
      }),
    ],
  }];

  test('resolves root and worktree scopes from unfiltered topology and excludes archived scopes', () => {
    expect(getProjectFolderScopesFromTopology(projectTopology, 'project-a')).toEqual([
      { scopeKey: '/workspace/project-a', directory: '/workspace/project-a' },
      { scopeKey: '/workspace/project-a-worktree', directory: '/workspace/project-a-worktree' },
    ]);
  });

  test('passes directory scopes to bulk folder actions instead of the project id', () => {
    expect(resolveSelectionFolderScopes(
      'project-a',
      (selectionScope) => getProjectFolderScopesFromTopology(projectTopology, selectionScope),
    )).toEqual(['/workspace/project-a', '/workspace/project-a-worktree']);
  });

  test('falls back to the normalized project directory when only archived groups exist', () => {
    expect(getProjectFolderScopesFromTopology([{
      project: { id: 'project-a', normalizedPath: '/workspace/project-a' },
      groups: [folderScopeGroup({
        id: 'archived',
        isMain: false,
        isArchivedBucket: true,
        directory: null,
        folderScopeKey: '/workspace/project-a/.archived',
      })],
    }], 'project-a')).toEqual([
      { scopeKey: '/workspace/project-a', directory: '/workspace/project-a' },
    ]);
  });

  test('resolves the selected project from complete topology in single-project mode', () => {
    const otherProject = {
      project: { id: 'project-b', normalizedPath: '/workspace/project-b' },
      groups: [folderScopeGroup({
        directory: '/workspace/project-b',
        folderScopeKey: '/workspace/project-b',
      })],
    };

    expect(getProjectFolderScopesFromTopology([otherProject, ...projectTopology], 'project-a').map((scope) => scope.scopeKey))
      .toEqual(['/workspace/project-a', '/workspace/project-a-worktree']);
  });

  test('uses every root and worktree scope owned by the selected project', () => {
    const scopes = resolveSelectionFolderScopes('project-a', (projectId) => projectId === 'project-a'
      ? [
        { scopeKey: '/workspace/project-a', directory: '/workspace/project-a' },
        { scopeKey: '/workspace/project-a-worktree', directory: '/workspace/project-a-worktree' },
      ]
      : []);

    expect(scopes).toEqual(['/workspace/project-a', '/workspace/project-a-worktree']);
  });

  test('keeps a directory scope when no project scope owns it', () => {
    expect(resolveSelectionFolderScopes('/workspace/vscode', () => [])).toEqual(['/workspace/vscode']);
  });

  test('deduplicates repeated project scope entries before exposing folder targets', () => {
    expect(resolveSelectionFolderScopes('project-a', () => [
      { scopeKey: '/workspace/project-a', directory: '/workspace/project-a' },
      { scopeKey: '/workspace/project-a', directory: '/workspace/project-a/' },
    ])).toEqual(['/workspace/project-a']);
  });

  test('resolves every configured and dated managed-chat scope from its shared owner', () => {
    const chatsRoot = '/home/user/.config/openchamber/chats';
    expect(resolveSelectionFolderScopes(chatsRoot, (selectionScope) => selectionScope === chatsRoot
      ? [
        { scopeKey: chatsRoot, directory: chatsRoot },
        { scopeKey: `${chatsRoot}/2026-09-13`, directory: `${chatsRoot}/2026-09-13` },
        { scopeKey: '/home/user/.config/openchamber/chats-legacy', directory: '/home/user/.config/openchamber/chats-legacy' },
      ]
      : [])).toEqual([
      chatsRoot,
      `${chatsRoot}/2026-09-13`,
      '/home/user/.config/openchamber/chats-legacy',
    ]);
  });
});

describe('deriveSessionRowBulkSelectAll', () => {
  const inScope = (id: string, occurrence = 0): SessionRowOrderEntry => ({ id, rowKey: `row:${id}:${occurrence}`, scopeKey: 'project-a', archived: false });
  const otherScope = (id: string, occurrence = 0): SessionRowOrderEntry => ({ id, rowKey: `row:${id}:${occurrence}`, scopeKey: 'project-b', archived: false });

  test('returns null when no rows are registered', () => {
    expect(deriveSessionRowBulkSelectAll([], null)).toBeNull();
  });

  test('selects every row in scope including rows with no mounted element', () => {
    const entries = [inScope('a'), inScope('offscreen-1'), otherScope('b'), inScope('offscreen-2')];

    expect(deriveSessionRowBulkSelectAll(entries, null)).toEqual({
      ids: ['a', 'offscreen-1', 'offscreen-2'],
      scopeKey: 'project-a',
    });
  });

  test('uses the store scope when one is set', () => {
    const entries = [inScope('a'), otherScope('b')];

    expect(deriveSessionRowBulkSelectAll(entries, 'project-b')).toEqual({
      ids: ['b'],
      scopeKey: 'project-b',
    });
  });

  test('returns null when the scope owns no registered row', () => {
    expect(deriveSessionRowBulkSelectAll([inScope('a')], 'project-b')).toBeNull();
  });

  test('keeps duplicate ids for offscreen copies', () => {
    const entries = [inScope('same', 0), inScope('same', 1)];

    expect(deriveSessionRowBulkSelectAll(entries, 'project-a')).toEqual({
      ids: ['same', 'same'],
      scopeKey: 'project-a',
    });
  });
});

describe('deriveSessionRowSelectionArchived', () => {
  const entry = (id: string, archived: boolean): SessionRowOrderEntry => ({ id, rowKey: `row:${id}`, scopeKey: 'project-a', archived });

  test('is archived only when every selected registered row is archived', () => {
    expect(deriveSessionRowSelectionArchived([entry('a', true), entry('b', true)], new Set(['a', 'b']))).toBe(true);
    expect(deriveSessionRowSelectionArchived([entry('a', true), entry('b', false)], new Set(['a', 'b']))).toBe(false);
    expect(deriveSessionRowSelectionArchived([entry('a', true), entry('b', false)], new Set(['a']))).toBe(true);
    expect(deriveSessionRowSelectionArchived([entry('a', true)], new Set(['missing']))).toBe(false);
  });

  test('covers selected rows whose element is not mounted', () => {
    const entries = [entry('mounted', false), entry('offscreen-archived', true)];

    expect(deriveSessionRowSelectionArchived(entries, new Set(['offscreen-archived']))).toBe(true);
  });

  test('does not classify an unregistered active selection as archived-only', () => {
    const entries = [entry('visible-archived', true)];

    expect(deriveSessionRowSelectionArchived(
      entries,
      new Set(['visible-archived', 'hidden-active']),
      new Map([
        ['visible-archived', sessionMetadata('visible-archived', true)],
        ['hidden-active', sessionMetadata('hidden-active', false)],
      ]),
    )).toBe(false);
  });

  test('treats selected ids missing from authoritative metadata as active', () => {
    expect(deriveSessionRowSelectionArchived(
      [entry('visible-archived', true)],
      new Set(['visible-archived', 'missing-metadata']),
      new Map([['visible-archived', sessionMetadata('visible-archived', true)]]),
    )).toBe(false);
  });

  test('preserves archived-only classification for authoritative metadata and deduplicated ids', () => {
    const entries = [entry('visible-archived', true), entry('visible-archived', true)];
    const selectedIds = new Set(['visible-archived', 'hidden-archived']);
    const selectedSessionsById = new Map([
      ['visible-archived', sessionMetadata('visible-archived', true)],
      ['hidden-archived', sessionMetadata('hidden-archived', true)],
    ]);

    expect(deriveSessionRowSelectionArchived(entries, selectedIds, selectedSessionsById)).toBe(true);
    expect([...selectedIds]).toEqual(['visible-archived', 'hidden-archived']);
  });
});

describe('deriveSessionRowSelectionScope', () => {
  const entries: SessionRowOrderEntry[] = [
    { id: 'a', rowKey: 'row:a', scopeKey: null, archived: false },
    { id: 'b', rowKey: 'row:b', scopeKey: '/repo/worktree', archived: false },
    { id: 'c', rowKey: 'row:c', scopeKey: 'project-a', archived: false },
  ];

  test('returns the first selected entry scope in render order', () => {
    expect(deriveSessionRowSelectionScope(entries, new Set(['a', 'b', 'c']))).toBe('/repo/worktree');
    expect(deriveSessionRowSelectionScope(entries, new Set(['c', 'a']))).toBe('project-a');
  });

  test('returns null when nothing selected has a scope', () => {
    expect(deriveSessionRowSelectionScope(entries, new Set(['a', 'missing']))).toBeNull();
  });

  test('uses the selected-id insertion order, not render order', () => {
    const rendered: SessionRowOrderEntry[] = [
      { id: 'renders-first', rowKey: 'row:renders-first', scopeKey: 'project-first', archived: false },
      { id: 'selected-first', rowKey: 'row:selected-first', scopeKey: 'project-second', archived: false },
    ];

    expect(deriveSessionRowSelectionScope(rendered, new Set(['selected-first', 'renders-first']))).toBe('project-second');
    expect(deriveSessionRowSelectionScope(rendered, new Set(['renders-first', 'selected-first']))).toBe('project-first');
  });

  test('skips an id whose first entry has no scope even when a later duplicate has one', () => {
    const duplicated: SessionRowOrderEntry[] = [
      { id: 'dup', rowKey: 'row:dup:first', scopeKey: null, archived: false },
      { id: 'dup', rowKey: 'row:dup:later', scopeKey: 'project-later', archived: false },
      { id: 'other', rowKey: 'row:other', scopeKey: 'project-other', archived: false },
    ];

    expect(deriveSessionRowSelectionScope(duplicated, new Set(['dup', 'other']))).toBe('project-other');
  });

  test('uses the first entry in render order for a duplicated id', () => {
    const duplicated: SessionRowOrderEntry[] = [
      { id: 'dup', rowKey: 'row:dup:first', scopeKey: 'project-first', archived: false },
      { id: 'dup', rowKey: 'row:dup:later', scopeKey: 'project-later', archived: false },
    ];

    expect(deriveSessionRowSelectionScope(duplicated, new Set(['dup']))).toBe('project-first');
  });

  test('treats an empty scope like no scope', () => {
    const emptyScope: SessionRowOrderEntry[] = [
      { id: 'empty', rowKey: 'row:empty', scopeKey: '', archived: false },
      { id: 'scoped', rowKey: 'row:scoped', scopeKey: 'project-a', archived: false },
    ];

    expect(deriveSessionRowSelectionScope(emptyScope, new Set(['empty', 'scoped']))).toBe('project-a');
  });
});
