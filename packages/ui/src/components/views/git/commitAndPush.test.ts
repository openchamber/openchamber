import { describe, expect, test } from 'bun:test';
import type { GitAPI, GitRemote, GitStatus } from '@/lib/api/types';
import { pushCommittedChanges } from './commitAndPush';

const remote = (name = 'origin'): GitRemote => ({ name, fetchUrl: '', pushUrl: '' });

const status = (overrides: Partial<GitStatus> = {}): GitStatus => ({
  current: 'feature',
  tracking: null,
  ahead: 0,
  behind: 0,
  files: [],
  isClean: true,
  ...overrides,
});

test('publishes a new branch even though status has no upstream ahead count', async () => {
  const pushes: Array<{ directory: string; remote?: string }> = [];
  const git: Pick<GitAPI, 'gitFetch' | 'getGitStatus' | 'gitPull' | 'gitPush'> = {
    gitFetch: async () => ({ success: true }),
    getGitStatus: async () => status(),
    gitPull: async () => { throw new Error('unexpected pull'); },
    gitPush: async (directory: string, options?: { remote?: string }) => {
      pushes.push({ directory, remote: options?.remote });
      return { success: true, pushed: [{ local: 'feature', remote: 'fork' }], repo: directory, ref: null };
    },
  };

  await pushCommittedChanges({
    git,
    directory: '/repo',
    remote: remote('fork'),
    dirtyWorktreeError: 'dirty',
  });

  expect(pushes).toEqual([{ directory: '/repo', remote: undefined }]);
});

for (const [name, remoteStatus, expectedCalls] of [
  ['ahead', status({ ahead: 1 }), ['fetch', 'push']],
  ['behind', status({ behind: 1 }), ['fetch', 'pull', 'push']],
  ['diverged', status({ ahead: 1, behind: 1 }), ['fetch', 'pull', 'push']],
] as const) {
  test(`pushes an existing ${name} branch after reconciling remote changes`, async () => {
    const calls: string[] = [];
    const git: Pick<GitAPI, 'gitFetch' | 'getGitStatus' | 'gitPull' | 'gitPush'> = {
      gitFetch: async () => { calls.push('fetch'); return { success: true }; },
      getGitStatus: async () => remoteStatus,
      gitPull: async () => {
        calls.push('pull');
        return { success: true, summary: { changes: 0, insertions: 0, deletions: 0 }, files: [], insertions: 0, deletions: 0 };
      },
      gitPush: async (directory: string) => {
        calls.push('push');
        return { success: true, pushed: [{ local: 'feature', remote: 'origin' }], repo: directory, ref: null };
      },
    };

    await pushCommittedChanges({
      git,
      directory: '/repo',
      remote: remote(),
      dirtyWorktreeError: 'dirty',
    });

    expect(calls).toEqual(expectedCalls);
  });
}

describe('pushCommittedChanges failures', () => {
  test('does not pull or push a behind branch with uncommitted changes', async () => {
    const git: Pick<GitAPI, 'gitFetch' | 'getGitStatus' | 'gitPull' | 'gitPush'> = {
      gitFetch: async () => ({ success: true }),
      getGitStatus: async () => status({ behind: 1, files: [{ path: 'local.ts', index: ' ', working_dir: 'M' }] }),
      gitPull: async () => { throw new Error('unexpected pull'); },
      gitPush: async () => { throw new Error('unexpected push'); },
    };

    await expect(pushCommittedChanges({
      git,
      directory: '/repo',
      remote: remote(),
      dirtyWorktreeError: 'commit or stash first',
    })).rejects.toThrow('commit or stash first');
  });

  test('does not report a push result when publishing fails', async () => {
    let reportedSuccess = false;
    const git: Pick<GitAPI, 'gitFetch' | 'getGitStatus' | 'gitPull' | 'gitPush'> = {
      gitFetch: async () => ({ success: true }),
      getGitStatus: async () => status({ ahead: 1 }),
      gitPull: async () => { throw new Error('unexpected pull'); },
      gitPush: async () => { throw new Error('remote rejected'); },
    };

    await expect(pushCommittedChanges({
      git,
      directory: '/repo',
      remote: remote(),
      dirtyWorktreeError: 'dirty',
      onPushed: () => { reportedSuccess = true; },
    })).rejects.toThrow('remote rejected');

    expect(reportedSuccess).toBe(false);
  });
});

test('only reports changed refs after first publication, a no-op, and a later push', async () => {
  const reported: string[] = [];
  const outcomes = [
    [{ local: 'refs/heads/feature', remote: 'fork' }],
    [],
    [{ local: 'refs/heads/feature', remote: 'fork' }],
  ];
  const git: Pick<GitAPI, 'gitFetch' | 'getGitStatus' | 'gitPull' | 'gitPush'> = {
    gitFetch: async () => ({ success: true }),
    getGitStatus: async () => status(),
    gitPull: async () => { throw new Error('unexpected pull'); },
    gitPush: async () => ({ success: true, pushed: outcomes.shift() ?? [], repo: '/repo', ref: null }),
  };
  for (const expectedCount of [1, 1, 2]) {
    await pushCommittedChanges({
      git,
      directory: '/repo',
      remote: remote(),
      dirtyWorktreeError: 'dirty',
      onPushed: (result) => { reported.push(result.pushed[0].remote); },
    });
    expect(reported).toHaveLength(expectedCount);
  }
  expect(reported).toEqual(['fork', 'fork']);
});

test('pulls the fetched upstream but leaves push routing to Git', async () => {
  const reported: string[] = [];
  const git: Pick<GitAPI, 'gitFetch' | 'getGitStatus' | 'gitPull' | 'gitPush'> = {
    gitFetch: async (_directory, options) => {
      expect(options).toEqual({ remote: 'upstream' });
      return { success: true };
    },
    getGitStatus: async () => status({ tracking: 'upstream/feature', behind: 1 }),
    gitPull: async (_directory, options) => {
      expect(options).toEqual({ remote: 'upstream', branch: 'feature', rebase: true });
      return { success: true, summary: { changes: 1, insertions: 1, deletions: 0 }, files: ['readme'], insertions: 1, deletions: 0 };
    },
    gitPush: async (_directory, options) => {
      expect(options).toBeUndefined();
      return { success: true, pushed: [{ local: 'feature', remote: 'fork' }], repo: '/repo', ref: null };
    },
  };
  await pushCommittedChanges({
    git,
    directory: '/repo',
    remote: remote('upstream'),
    dirtyWorktreeError: 'dirty',
    onPulled: (result) => { reported.push(...result.files); },
    onPushed: (result) => { reported.push(result.pushed[0].remote); },
  });
  expect(reported).toEqual(['readme', 'fork']);
});
