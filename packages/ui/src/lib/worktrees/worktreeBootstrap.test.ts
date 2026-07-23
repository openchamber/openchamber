import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { GitWorktreeBootstrapStatus } from '@/lib/api/types';

const bootstrapStatusCalls: string[] = [];
let bootstrapStatusResult: GitWorktreeBootstrapStatus = {
  status: 'ready',
  error: null,
  updatedAt: 1,
};
let getBootstrapStatus = (): Promise<GitWorktreeBootstrapStatus> => Promise.resolve(bootstrapStatusResult);
const toastErrors: Array<{ title: string; description?: string }> = [];

mock.module('@/components/ui', () => ({
  toast: {
    error: (title: string, options?: { description?: string }) => {
      toastErrors.push({ title, description: options?.description });
    },
  },
}));

mock.module('@/lib/i18n', () => ({
  formatMessage: (_dictionary: Record<string, string>, key: string) => key,
  useI18nStore: {
    getState: () => ({ dictionary: {} }),
  },
}));

mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: () => ({
    git: {
      worktree: {
        bootstrapStatus: (directory: string) => {
          bootstrapStatusCalls.push(directory);
          return getBootstrapStatus();
        },
      },
    },
  }),
}));

mock.module('@/lib/gitApiHttp', () => ({
  getGitWorktreeBootstrapStatus: (directory: string) => {
    bootstrapStatusCalls.push(directory);
    return getBootstrapStatus();
  },
}));

const {
  clearWorktreeBootstrapState,
  getWorktreeBootstrapState,
  markWorktreeBootstrapPending,
  setWorktreeBootstrapState,
  startWorktreeBootstrapWatcher,
  waitForWorktreeBootstrap,
  waitForWorktreeGitReady,
} = await import('./worktreeBootstrap');

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for condition');
};

describe('worktreeBootstrap.waitForWorktreeBootstrap', () => {
  beforeEach(() => {
    bootstrapStatusCalls.length = 0;
    toastErrors.length = 0;
    bootstrapStatusResult = { status: 'ready', error: null, updatedAt: 1 };
    getBootstrapStatus = () => Promise.resolve(bootstrapStatusResult);
    clearWorktreeBootstrapState('/repo');
    clearWorktreeBootstrapState('/repo-wt');
  });

  test('does not poll directories that were not marked pending', async () => {
    await waitForWorktreeBootstrap('/repo');

    expect(bootstrapStatusCalls).toEqual([]);
  });

  test('polls when the directory was explicitly marked pending', async () => {
    markWorktreeBootstrapPending('/repo-wt');

    await waitForWorktreeBootstrap('/repo-wt');

    expect(bootstrapStatusCalls).toEqual(['/repo-wt']);
  });

  test('git-ready wait does not wait for setup-ready', async () => {
    setWorktreeBootstrapState('/repo-wt', {
      status: 'pending',
      phase: 'git-ready',
      error: null,
      updatedAt: 1,
    });

    await waitForWorktreeGitReady('/repo-wt');

    expect(bootstrapStatusCalls).toEqual([]);
  });

  test('git-ready wait remains compatible with ready responses that omit phase', async () => {
    markWorktreeBootstrapPending('/repo-wt');

    await waitForWorktreeGitReady('/repo-wt');

    expect(bootstrapStatusCalls).toEqual(['/repo-wt']);
    expect(getWorktreeBootstrapState('/repo-wt')).toEqual(bootstrapStatusResult);
  });

  test('dedupes concurrent waiters for the same phase', async () => {
    let resolveStatus!: (status: GitWorktreeBootstrapStatus) => void;
    getBootstrapStatus = () => new Promise((resolve) => {
      resolveStatus = resolve;
    });
    markWorktreeBootstrapPending('/repo-wt');

    const first = waitForWorktreeGitReady('/repo-wt');
    const second = waitForWorktreeGitReady('/repo-wt');
    await waitFor(() => bootstrapStatusCalls.length === 1);
    resolveStatus({ status: 'pending', phase: 'git-ready', error: null, updatedAt: 2 });

    await Promise.all([first, second]);
    expect(bootstrapStatusCalls).toEqual(['/repo-wt']);
  });

  test('does not let a cleared waiter restore stale state or remove a replacement waiter', async () => {
    const statusResolvers: Array<(status: GitWorktreeBootstrapStatus) => void> = [];
    getBootstrapStatus = () => new Promise((resolve) => {
      statusResolvers.push(resolve);
    });
    markWorktreeBootstrapPending('/repo-wt');

    const staleWaiter = waitForWorktreeGitReady('/repo-wt');
    await waitFor(() => statusResolvers.length === 1);
    clearWorktreeBootstrapState('/repo-wt');
    markWorktreeBootstrapPending('/repo-wt');
    const replacementWaiter = waitForWorktreeGitReady('/repo-wt');
    await waitFor(() => statusResolvers.length === 2);

    statusResolvers[0]({ status: 'pending', phase: 'git-ready', error: null, updatedAt: 2 });
    await expect(staleWaiter).rejects.toThrow('cancelled');
    expect(getWorktreeBootstrapState('/repo-wt')?.phase).toBe('directory-created');

    statusResolvers[1]({ status: 'pending', phase: 'git-ready', error: null, updatedAt: 3 });
    await replacementWaiter;
    expect(getWorktreeBootstrapState('/repo-wt')?.phase).toBe('git-ready');
    expect(bootstrapStatusCalls).toEqual(['/repo-wt', '/repo-wt']);
  });

  test('does not regress a newer phase when concurrent polls resolve out of order', async () => {
    const statusResolvers: Array<(status: GitWorktreeBootstrapStatus) => void> = [];
    getBootstrapStatus = () => new Promise((resolve) => {
      statusResolvers.push(resolve);
    });
    markWorktreeBootstrapPending('/repo-wt');

    startWorktreeBootstrapWatcher('/repo-wt', { pollIntervalMs: 1000 });
    await waitFor(() => statusResolvers.length === 1);
    const gitReadyWaiter = waitForWorktreeGitReady('/repo-wt');
    await waitFor(() => statusResolvers.length === 2);

    statusResolvers[1]({ status: 'pending', phase: 'git-ready', error: null, updatedAt: 3 });
    await gitReadyWaiter;
    statusResolvers[0]({ status: 'pending', phase: 'directory-created', error: null, updatedAt: 2 });
    await Promise.resolve();

    expect(getWorktreeBootstrapState('/repo-wt')?.phase).toBe('git-ready');
    clearWorktreeBootstrapState('/repo-wt');
  });

  test('full bootstrap wait continues through git-ready until setup-ready', async () => {
    setWorktreeBootstrapState('/repo-wt', {
      status: 'pending',
      phase: 'git-ready',
      error: null,
      updatedAt: 1,
    });
    bootstrapStatusResult = {
      status: 'ready',
      phase: 'setup-ready',
      error: null,
      updatedAt: 2,
    };

    await waitForWorktreeBootstrap('/repo-wt');

    expect(bootstrapStatusCalls).toEqual(['/repo-wt']);
  });

  test('background watcher polls pending worktrees without blocking', async () => {
    markWorktreeBootstrapPending('/repo-wt');
    const readyStatuses: Array<{ status: 'pending' | 'ready' | 'failed'; error: string | null; updatedAt: number }> = [];

    startWorktreeBootstrapWatcher('/repo-wt', {
      pollIntervalMs: 0,
      onReady: (status) => readyStatuses.push(status),
    });

    await waitFor(() => readyStatuses.length === 1);
    expect(bootstrapStatusCalls).toEqual(['/repo-wt']);
    expect(readyStatuses.map((status) => status.status)).toEqual(['ready']);
    expect(toastErrors).toEqual([]);
  });

  test('background watcher shows a toast when bootstrap fails', async () => {
    bootstrapStatusResult = { status: 'failed', error: 'setup failed', updatedAt: 2 };
    markWorktreeBootstrapPending('/repo-wt');

    startWorktreeBootstrapWatcher('/repo-wt', { pollIntervalMs: 0 });

    await waitFor(() => toastErrors.length === 1);
    expect(toastErrors).toEqual([{ title: 'worktree.bootstrap.toast.failed', description: 'setup failed' }]);
  });

  test('background watcher marks failed and toasts when bootstrap times out', async () => {
    bootstrapStatusResult = { status: 'pending', error: null, updatedAt: 2 };
    markWorktreeBootstrapPending('/repo-wt');
    const failedStatuses: Array<{ status: 'pending' | 'ready' | 'failed'; error: string | null; updatedAt: number }> = [];

    startWorktreeBootstrapWatcher('/repo-wt', {
      timeoutMs: 0,
      pollIntervalMs: 0,
      onFailed: (status) => failedStatuses.push(status),
    });

    await waitFor(() => toastErrors.length === 1);
    expect(getWorktreeBootstrapState('/repo-wt')?.status).toBe('failed');
    expect(failedStatuses.map((status) => status.status)).toEqual(['failed']);
    expect(toastErrors).toEqual([{
      title: 'worktree.bootstrap.toast.failed',
      description: 'worktree.bootstrap.toast.timeoutDescription',
    }]);
  });

  test('background watcher is deduped per directory', async () => {
    bootstrapStatusResult = { status: 'pending', error: null, updatedAt: 2 };
    markWorktreeBootstrapPending('/repo-wt');

    startWorktreeBootstrapWatcher('/repo-wt', { pollIntervalMs: 1000 });
    startWorktreeBootstrapWatcher('/repo-wt', { pollIntervalMs: 1000 });

    await waitFor(() => bootstrapStatusCalls.length === 1);
    expect(bootstrapStatusCalls).toEqual(['/repo-wt']);
    clearWorktreeBootstrapState('/repo-wt');
  });
});
