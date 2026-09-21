import { describe, expect, test } from 'bun:test';

import { removeWorktreeThenArchiveSessions } from './worktreeRemovalFlow';

describe('removeWorktreeThenArchiveSessions', () => {
  test('does not archive linked sessions when worktree removal fails', async () => {
    let archiveCalled = false;
    const result = await removeWorktreeThenArchiveSessions({
      sessionIds: ['session-one'],
      removeWorktree: async () => false,
      archiveSessions: async () => {
        archiveCalled = true;
        return { archivedIds: ['session-one'], failedIds: [] };
      },
    });

    expect(result.removed).toBe(false);
    expect(archiveCalled).toBe(false);
  });

  test('archives linked sessions only after worktree removal succeeds', async () => {
    const calls: string[] = [];
    const result = await removeWorktreeThenArchiveSessions({
      sessionIds: ['session-one', 'session-two'],
      removeWorktree: async () => {
        calls.push('remove');
        return true;
      },
      archiveSessions: async (sessionIds) => {
        calls.push(`archive:${sessionIds.join(',')}`);
        return { archivedIds: ['session-one'], failedIds: ['session-two'] };
      },
    });

    expect(calls).toEqual(['remove', 'archive:session-one,session-two']);
    expect(result.archive).toEqual({ archivedIds: ['session-one'], failedIds: ['session-two'] });
  });
});
