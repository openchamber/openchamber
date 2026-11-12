import { expect, test } from 'bun:test';
import type { GitCommitResult } from '@/lib/api/types';
import { commitAndSwitchBranch } from './mobileDirtySwitch';

test('dirty branch switching publishes through the managed chooser and keeps the branch after a failed push', async () => {
  for (const outcome of ['published', 'failed', 'local'] as const) {
    const events: string[] = [];
    await commitAndSwitchBranch('Save changes', outcome !== 'local', {
      targetBranch: 'main',
      directory: '/project/nested',
      sourceBranch: 'feature',
      git: {
        createGitCommit: async (directory: string): Promise<GitCommitResult> => {
          events.push(`commit:${directory}`);
          return { success: true, commit: 'abc', branch: 'feature', summary: { changes: 1, insertions: 1, deletions: 0 } };
        },
      },
      publishChooser: {
        prepare: async (action) => {
          events.push(`prepare:${action}`);
          return async () => {
            events.push('publish');
            if (outcome === 'failed') throw new Error('Push rejected');
            return null;
          };
        },
      },
      toast: { success: () => {}, error: () => { events.push('error'); } },
      t: (key) => key,
      refreshStatusAndBranches: async () => { events.push('refresh'); },
      closeDialog: () => { events.push('close'); },
      performCheckout: async (branch) => { events.push(`checkout:${branch}`); },
    });
    expect(events).toEqual(outcome === 'local'
      ? ['commit:/project/nested', 'refresh', 'close', 'checkout:main']
      : outcome === 'failed'
        ? ['commit:/project/nested', 'prepare:push', 'publish', 'error', 'refresh', 'close']
        : ['commit:/project/nested', 'prepare:push', 'publish', 'refresh', 'close', 'checkout:main']);
  }
});
