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
  const git = {
    gitFetch: async () => ({ success: true }),
    getGitStatus: async () => status(),
    gitPull: async () => { throw new Error('unexpected pull'); },
    gitPush: async (directory: string, options?: { remote?: string }) => {
      pushes.push({ directory, remote: options?.remote });
      return { success: true, pushed: [{ local: 'feature', remote: 'fork' }], repo: directory, ref: null };
    },
  } as Pick<GitAPI, 'gitFetch' | 'getGitStatus' | 'gitPull' | 'gitPush'>;

  await pushCommittedChanges({
    git,
    directory: '/repo',
    remote: remote('fork'),
    status: status(),
    dirtyWorktreeError: 'dirty',
  });

  expect(pushes).toEqual([{ directory: '/repo', remote: 'fork' }]);
});

for (const [name, remoteStatus, expectedCalls] of [
  ['ahead', status({ ahead: 1 }), ['fetch', 'push']],
  ['behind', status({ behind: 1 }), ['fetch', 'pull', 'push']],
  ['diverged', status({ ahead: 1, behind: 1 }), ['fetch', 'pull', 'push']],
] as const) {
  test(`pushes an existing ${name} branch after reconciling remote changes`, async () => {
    const calls: string[] = [];
    const git = {
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
    } as Pick<GitAPI, 'gitFetch' | 'getGitStatus' | 'gitPull' | 'gitPush'>;

    await pushCommittedChanges({
      git,
      directory: '/repo',
      remote: remote(),
      status: status({ tracking: 'origin/feature' }),
      dirtyWorktreeError: 'dirty',
    });

    expect(calls).toEqual(expectedCalls);
  });
}

describe('pushCommittedChanges failures', () => {
  test('does not pull or push a behind branch with uncommitted changes', async () => {
    const git = {
      gitFetch: async () => ({ success: true }),
      getGitStatus: async () => status({ behind: 1, files: [{ path: 'local.ts', index: ' ', working_dir: 'M' }] }),
      gitPull: async () => { throw new Error('unexpected pull'); },
      gitPush: async () => { throw new Error('unexpected push'); },
    } as Pick<GitAPI, 'gitFetch' | 'getGitStatus' | 'gitPull' | 'gitPush'>;

    await expect(pushCommittedChanges({
      git,
      directory: '/repo',
      remote: remote(),
      status: status({ tracking: 'origin/feature' }),
      dirtyWorktreeError: 'commit or stash first',
    })).rejects.toThrow('commit or stash first');
  });

  test('does not report a push result when publishing fails', async () => {
    let reportedSuccess = false;
    const git = {
      gitFetch: async () => ({ success: true }),
      getGitStatus: async () => status({ ahead: 1 }),
      gitPull: async () => { throw new Error('unexpected pull'); },
      gitPush: async () => { throw new Error('remote rejected'); },
    } as Pick<GitAPI, 'gitFetch' | 'getGitStatus' | 'gitPull' | 'gitPush'>;

    await expect(pushCommittedChanges({
      git,
      directory: '/repo',
      remote: remote(),
      status: status({ tracking: 'origin/feature' }),
      dirtyWorktreeError: 'dirty',
      onPushed: () => { reportedSuccess = true; },
    })).rejects.toThrow('remote rejected');

    expect(reportedSuccess).toBe(false);
  });
});
