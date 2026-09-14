import { describe, expect, test } from 'bun:test';
import { resolveSelectionFolderScopes } from './useSidebarBulkActions';
import {
  deriveSessionRowBulkSelectAll,
  deriveSessionRowSelectionArchived,
  deriveSessionRowSelectionScope,
  type SessionRowOrderEntry,
} from '../sessions/sessionRowOrderUtils';

describe('sidebar bulk project scopes', () => {
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
});

describe('deriveSessionRowBulkSelectAll', () => {
  const inScope = (id: string): SessionRowOrderEntry => ({ id, scopeKey: 'project-a', archived: false });
  const otherScope = (id: string): SessionRowOrderEntry => ({ id, scopeKey: 'project-b', archived: false });

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
    const entries = [inScope('same'), inScope('same')];

    expect(deriveSessionRowBulkSelectAll(entries, 'project-a')).toEqual({
      ids: ['same', 'same'],
      scopeKey: 'project-a',
    });
  });
});

describe('deriveSessionRowSelectionArchived', () => {
  const entry = (id: string, archived: boolean): SessionRowOrderEntry => ({ id, scopeKey: 'project-a', archived });

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
});

describe('deriveSessionRowSelectionScope', () => {
  const entries: SessionRowOrderEntry[] = [
    { id: 'a', scopeKey: null, archived: false },
    { id: 'b', scopeKey: '/repo/worktree', archived: false },
    { id: 'c', scopeKey: 'project-a', archived: false },
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
      { id: 'renders-first', scopeKey: 'project-first', archived: false },
      { id: 'selected-first', scopeKey: 'project-second', archived: false },
    ];

    expect(deriveSessionRowSelectionScope(rendered, new Set(['selected-first', 'renders-first']))).toBe('project-second');
    expect(deriveSessionRowSelectionScope(rendered, new Set(['renders-first', 'selected-first']))).toBe('project-first');
  });

  test('skips an id whose first entry has no scope even when a later duplicate has one', () => {
    const duplicated: SessionRowOrderEntry[] = [
      { id: 'dup', scopeKey: null, archived: false },
      { id: 'dup', scopeKey: 'project-later', archived: false },
      { id: 'other', scopeKey: 'project-other', archived: false },
    ];

    expect(deriveSessionRowSelectionScope(duplicated, new Set(['dup', 'other']))).toBe('project-other');
  });

  test('uses the first entry in render order for a duplicated id', () => {
    const duplicated: SessionRowOrderEntry[] = [
      { id: 'dup', scopeKey: 'project-first', archived: false },
      { id: 'dup', scopeKey: 'project-later', archived: false },
    ];

    expect(deriveSessionRowSelectionScope(duplicated, new Set(['dup']))).toBe('project-first');
  });

  test('treats an empty scope like no scope', () => {
    const emptyScope: SessionRowOrderEntry[] = [
      { id: 'empty', scopeKey: '', archived: false },
      { id: 'scoped', scopeKey: 'project-a', archived: false },
    ];

    expect(deriveSessionRowSelectionScope(emptyScope, new Set(['empty', 'scoped']))).toBe('project-a');
  });
});
