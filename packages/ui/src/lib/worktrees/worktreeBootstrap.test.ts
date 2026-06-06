import { beforeEach, describe, expect, mock, test } from 'bun:test';

const bootstrapStatusCalls: string[] = [];
let bootstrapStatusResult = { status: 'ready' as const, error: null, updatedAt: 1 };

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
  markWorktreeBootstrapPending,
  waitForWorktreeBootstrap,
} = await import('./worktreeBootstrap');

describe('worktreeBootstrap.waitForWorktreeBootstrap', () => {
  beforeEach(() => {
    bootstrapStatusCalls.length = 0;
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
});
