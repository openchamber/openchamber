import { describe, expect, test } from 'bun:test';

import { GitWorktreeRequestError } from '@/lib/api/types';
import type { Session } from '@/lib/opencode/model';

import { archiveSessionsThenRemoveWorktree, deleteWithoutTeardownToast, groupSessionTreesByFolder, moveSessionsThenRemoveWorktree, WorktreeKeepStoppedError } from './worktreeRemovalFlow';

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

const WORKTREE = '/repo-worktrees/feature';

const session = (id: string, directory: string, parentID?: string): Session => ({
  id,
  directory,
  parentID,
  projectID: 'project',
  title: id,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
});

type FlowOptions = Parameters<typeof moveSessionsThenRemoveWorktree>[0];

// The worktree holds `sessions` until each one's tree moves out.
const flow = (sessions: Session[], calls: string[], overrides: Partial<FlowOptions> = {}): Promise<{ removed: boolean }> => {
  const moved = new Set<string>();
  return moveSessionsThenRemoveWorktree({
    worktreePath: WORKTREE,
    readSessions: () => sessions.filter((entry) => !moved.has(entry.id)),
    readActivity: async () => 'idle',
    resolveDestination: async (directory: string) => (directory.endsWith('/ai') ? '/repo/ai' : '/repo'),
    moveTree: async (tree) => {
      const members = [...tree.descendants, tree.root];
      calls.push(`move:${members.map((entry) => entry.id).join(',')} ${tree.sourceDirectory} -> ${tree.projectDirectory}`);
      for (const member of members) moved.add(member.id);
    },
    confirmMoves: async (moves) => {
      calls.push(`confirm:${moves.map((move) => move.root.id).join(',')}`);
      return true;
    },
    removeWorktree: async () => {
      calls.push('remove');
      return true;
    },
    isCurrent: () => true,
    ...overrides,
  });
};

const stopReason = async (run: Promise<{ removed: boolean }>): Promise<string> => {
  try {
    await run;
    return 'resolved';
  } catch (error) {
    return error instanceof WorktreeKeepStoppedError ? error.reason : String(error);
  }
};

describe('moveSessionsThenRemoveWorktree', () => {
  test('moves each folder\'s trees to their project, subsessions first, then removes the worktree', async () => {
    const calls: string[] = [];
    // Shuffled: a grandchild before its parent and the root last.
    const result = await flow([
      session('grandchild', WORKTREE, 'child'),
      session('ai-session', `${WORKTREE}/ai`),
      session('child', WORKTREE, 'root'),
      session('root', WORKTREE),
    ], calls);

    expect(calls).toEqual([
      `move:grandchild,child,root ${WORKTREE} -> /repo`,
      `move:ai-session ${WORKTREE}/ai -> /repo/ai`,
      'confirm:root,ai-session',
      'remove',
    ]);
    expect(result).toEqual({ removed: true });
  });

  test('a subsession in another folder of the checkout moves as its own tree', () => {
    const trees = groupSessionTreesByFolder([
      session('root', WORKTREE),
      session('child-in-sub', `${WORKTREE}/sub`, 'root'),
    ]);

    expect(trees.map((tree) => [tree.root.id, tree.descendants.map((entry) => entry.id), tree.sourceDirectory])).toEqual([
      ['root', [], WORKTREE],
      ['child-in-sub', [], `${WORKTREE}/sub`],
    ]);
  });

  test('a running session stops it before anything moves or is removed', async () => {
    const calls: string[] = [];
    const reason = await stopReason(flow(
      [session('root', WORKTREE), session('child', WORKTREE, 'root')],
      calls,
      { readActivity: async (sessions) => (sessions.some((entry) => entry.id === 'child') ? 'active' : 'idle') },
    ));

    expect(reason).toBe('busy');
    expect(calls).toEqual([]);
  });

  test('a status read that fails stops it as unknown, never as idle', async () => {
    const calls: string[] = [];
    const reason = await stopReason(flow([session('root', WORKTREE)], calls, { readActivity: async () => 'unknown' }));

    expect(reason).toBe('unknown');
    expect(calls).toEqual([]);
  });

  test('a destination inside the worktree stops it before anything moves', async () => {
    const calls: string[] = [];
    // A project registered inside the checkout would be removed with it.
    await expect(flow([session('root', WORKTREE), session('ai-session', `${WORKTREE}/ai`)], calls, {
      resolveDestination: async (directory) => (directory.endsWith('/ai') ? `${WORKTREE}/ai` : '/repo'),
    })).rejects.toThrow('inside the worktree');

    expect(calls).toEqual([]);
  });

  test('a failed tree move keeps the worktree and the trees already moved', async () => {
    const calls: string[] = [];
    await expect(flow([session('first', WORKTREE), session('second', `${WORKTREE}/ai`)], calls, {
      moveTree: async (tree) => {
        if (tree.root.id === 'second') throw new Error('Session is not idle');
        calls.push(`move:${tree.root.id}`);
      },
    })).rejects.toThrow('Session is not idle');

    expect(calls).toEqual(['move:first']);
  });

  test('a session that started in the worktree during the moves keeps the worktree', async () => {
    const calls: string[] = [];
    const late = session('late', WORKTREE);
    const reason = await stopReason(flow([session('root', WORKTREE)], calls, {
      readSessions: (() => {
        let reads = 0;
        // The first read is the set to move; by the last one a new session sits there.
        return () => (reads++ === 0 ? [session('root', WORKTREE)] : [late]);
      })(),
    }));

    expect(reason).toBe('added');
    expect(calls).toEqual([`move:root ${WORKTREE} -> /repo`, 'confirm:root']);
  });

  test('a moved session the list still places in the worktree does not keep it', async () => {
    const calls: string[] = [];
    // The local list can lag a move the server already applied and still
    // return the session at its old folder.
    const result = await flow([session('root', WORKTREE)], calls, {
      readSessions: () => [session('root', WORKTREE)],
    });

    expect(calls).toEqual([`move:root ${WORKTREE} -> /repo`, 'confirm:root', 'remove']);
    expect(result).toEqual({ removed: true });
  });

  test('a move the server has not applied keeps the worktree', async () => {
    const calls: string[] = [];
    const reason = await stopReason(flow([session('root', WORKTREE)], calls, {
      confirmMoves: async () => false,
    }));

    expect(reason).toBe('unconfirmed');
    expect(calls).toEqual([`move:root ${WORKTREE} -> /repo`]);
  });

  test('a switch to another server during the wait for the moves says so, not that a move failed', async () => {
    const calls: string[] = [];
    let current = true;
    const reason = await stopReason(flow([session('root', WORKTREE)], calls, {
      isCurrent: () => current,
      confirmMoves: async () => {
        current = false;
        return false;
      },
    }));

    expect(reason).toBe('switched');
    expect(calls).toEqual([`move:root ${WORKTREE} -> /repo`]);
  });

  test('a switch to another server stops it before the next move and before the removal', async () => {
    const calls: string[] = [];
    let current = true;
    const reason = await stopReason(flow([session('first', WORKTREE), session('second', `${WORKTREE}/ai`)], calls, {
      isCurrent: () => current,
      moveTree: async (tree) => {
        calls.push(`move:${tree.root.id}`);
        current = false;
      },
    }));

    expect(reason).toBe('switched');
    expect(calls).toEqual(['move:first']);
  });

  test('a failed removal leaves the moved sessions in the project', async () => {
    const calls: string[] = [];
    const result = await flow([session('root', WORKTREE)], calls, {
      removeWorktree: async () => {
        calls.push('remove');
        return false;
      },
    });

    expect(calls).toEqual([`move:root ${WORKTREE} -> /repo`, 'confirm:root', 'remove']);
    expect(result).toEqual({ removed: false });
  });

  test('removes a worktree with no sessions without reading statuses', async () => {
    const calls: string[] = [];
    let statusRead = false;
    const result = await flow([], calls, {
      readActivity: async () => {
        statusRead = true;
        return 'unknown';
      },
    });

    expect(statusRead).toBe(false);
    expect(calls).toEqual(['remove']);
    expect(result).toEqual({ removed: true });
  });
});
