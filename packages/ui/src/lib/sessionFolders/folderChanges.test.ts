import { describe, expect, test } from 'bun:test';
import { applyFolderChange } from './folderChanges';

describe('applyFolderChange', () => {
  test('does not create an id already owned by another scope', () => {
    const folder = { id: 'shared', name: 'Keep', sessionIds: ['s1'], createdAt: 1, parentId: null };
    const map = { '/repo': [folder] };

    const next = applyFolderChange(map, {
      type: 'create',
      scopeKey: '/worktree',
      folder: { id: 'shared', name: 'Collision', parentId: null, createdAt: 2 },
    });

    expect(next).toBe(map);
    expect(next).toEqual({ '/repo': [folder] });
  });
});
