import { beforeEach, describe, expect, mock, test } from 'bun:test';

const bootstrapStatusCalls: string[] = [];
let bootstrapStatusResult: { status: 'pending' | 'ready' | 'failed'; error: string | null; updatedAt: number } = {
  status: 'ready',
  error: null,
  updatedAt: 1,
};
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
          return Promise.resolve(bootstrapStatusResult);
        },
      },
    },
  }),
}));

mock.module('@/lib/gitApiHttp', () => ({
  getGitWorktreeBootstrapStatus: (directory: string) => {
    bootstrapStatusCalls.push(directory);
    return Promise.resolve(bootstrapStatusResult);
  },
}));

const {
  clearWorktreeBootstrapState,
  getWorktreeBootstrapState,
  markWorktreeBootstrapPending,
  startWorktreeBootstrapWatcher,
  waitForWorktreeBootstrap,
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
