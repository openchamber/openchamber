import { describe, expect, test } from 'bun:test';
import { resolveBulkDeleteConfirmation, resolveSelectionFolderScopes } from './useSidebarBulkActions';

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

describe('bulk delete confirmation authority', () => {
  test('executes only the unchanged immutable target snapshot', () => {
    const value = { sessionIds: ['a', 'b'], sessionCount: 2, archivedBucket: true };
    const sessions = new Map([
      ['a', { time: { archived: 1 } }],
      ['b', { time: { archived: 2 } }],
    ]);

    expect(resolveBulkDeleteConfirmation(value, sessions)).toEqual({ ready: true, value });
  });

  test('requires confirmation again when targets change, keeping a requested delete a delete', () => {
    const value = { sessionIds: ['a', 'b'], sessionCount: 2, archivedBucket: true };
    const sessions = new Map([['a', { time: { archived: 0 } }]]);

    expect(resolveBulkDeleteConfirmation(value, sessions)).toEqual({
      ready: false,
      value: { sessionIds: ['a'], sessionCount: 1, archivedBucket: true },
    });
  });

  test('turns a requested archive into a delete once every target is already archived', () => {
    const value = { sessionIds: ['a', 'b'], sessionCount: 2, archivedBucket: false };
    const sessions = new Map([['a', { time: { archived: 1 } }], ['b', { time: { archived: 2 } }]]);

    expect(resolveBulkDeleteConfirmation(value, sessions)).toEqual({
      ready: false,
      value: { sessionIds: ['a', 'b'], sessionCount: 2, archivedBucket: true },
    });
  });
});
