import { describe, expect, test } from 'bun:test';

import { GitWorktreeRequestError } from '@/lib/api/types';
import { archiveSessionsThenRemoveWorktree, deleteWithoutTeardownToast } from './worktreeRemovalFlow';

describe('deleteWithoutTeardownToast', () => {
  test('offers the retry only for a delete its teardown stopped, from the server or the extension host, and waits for it', () => {
    const retries: string[] = [];
    const fromServer = new GitWorktreeRequestError('WORKTREE_TEARDOWN_FAILED', 'Worktree teardown command failed', 500);
    const fromBridge = Object.assign(new Error('Worktree teardown command failed'), { code: 'WORKTREE_TEARDOWN_FAILED' });

    for (const error of [fromServer, fromBridge]) {
      const options = deleteWithoutTeardownToast(error, 'Delete without teardown', () => retries.push('again'));
      expect(options?.action.label).toBe('Delete without teardown');
      expect(options?.duration).toBe(Infinity);
      options?.action.onClick();
    }
    expect(retries).toEqual(['again', 'again']);

    for (const error of [new Error('folder in use'), new GitWorktreeRequestError('WORKTREE_ARCHIVE_PARTIAL', 'partial', 500)]) {
      expect(deleteWithoutTeardownToast(error, 'Delete without teardown', () => retries.push('never'))).toBeUndefined();
    }
    expect(retries).toEqual(['again', 'again']);
  });
});

describe('archiveSessionsThenRemoveWorktree', () => {
  test('archives linked sessions while the worktree still exists, then removes it', async () => {
    const calls: string[] = [];
    const result = await archiveSessionsThenRemoveWorktree({
      sessionIds: ['session-one', 'session-two'],
      archiveSessions: async (sessionIds) => {
        calls.push(`archive:${sessionIds.join(',')}`);
        return { archivedIds: ['session-one'], failedIds: ['session-two'] };
      },
      removeWorktree: async (archivedIds) => {
        calls.push(`remove:${archivedIds.join(',')}`);
        return true;
      },
      restoreSessions: async (sessionIds) => {
        calls.push(`restore:${sessionIds.join(',')}`);
        return { failedIds: [] };
      },
    });

    // An archive of the worktree records exactly the sessions that went.
    expect(calls).toEqual(['archive:session-one,session-two', 'remove:session-one']);
    expect(result).toEqual({ removed: true, archive: { archivedIds: ['session-one'], failedIds: ['session-two'] } });
  });

  test('restores the sessions it archived when the removal fails', async () => {
    const calls: string[] = [];
    const result = await archiveSessionsThenRemoveWorktree({
      sessionIds: ['session-one', 'session-two'],
      archiveSessions: async () => ({ archivedIds: ['session-one'], failedIds: ['session-two'] }),
      removeWorktree: async () => false,
      restoreSessions: async (sessionIds) => {
        calls.push(`restore:${sessionIds.join(',')}`);
        return { failedIds: [] };
      },
    });

    expect(calls).toEqual(['restore:session-one']);
    expect(result).toEqual({ removed: false, archive: { archivedIds: [], failedIds: [] } });
  });

  test('restores the sessions and passes the error on when the removal throws', async () => {
    const restored: string[] = [];
    await expect(archiveSessionsThenRemoveWorktree({
      sessionIds: ['session-one'],
      archiveSessions: async () => ({ archivedIds: ['session-one'], failedIds: [] }),
      removeWorktree: async () => { throw new Error('remote branch kept'); },
      restoreSessions: async (sessionIds) => {
        restored.push(...sessionIds);
        return { failedIds: [] };
      },
    })).rejects.toThrow('remote branch kept');
    expect(restored).toEqual(['session-one']);
  });

  test('removes a worktree with no sessions without archiving anything', async () => {
    let archived = false;
    const result = await archiveSessionsThenRemoveWorktree({
      sessionIds: [],
      archiveSessions: async () => {
        archived = true;
        return { archivedIds: [], failedIds: [] };
      },
      removeWorktree: async () => true,
      restoreSessions: async () => ({ failedIds: [] }),
    });

    expect(archived).toBe(false);
    expect(result.removed).toBe(true);
  });
});
