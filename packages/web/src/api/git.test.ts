import { describe, expect, it } from 'vitest';

describe('createWebGitAPI', () => {
  it('exposes bulk stage and unstage methods', async () => {
    const { createWebGitAPI } = await import('./git');
    const api = createWebGitAPI();

    expect(typeof api.stageGitFiles).toBe('function');
    expect(typeof api.unstageGitFiles).toBe('function');
    expect(typeof api.stageGitHunk).toBe('function');
    expect(typeof api.unstageGitHunk).toBe('function');
    expect(typeof api.revertGitHunk).toBe('function');
    expect(api.planNetworkOperation).toBeDefined();
    expect(api.executeNetworkOperation).toBeDefined();
    expect(api.getNetworkOperation).toBeDefined();
    expect(api.cancelNetworkOperation).toBeDefined();
  });

  // `gitApi.ts` rejects these when a registered runtime omits them, and every
  // web, desktop and mobile surface runs through this adapter.
  it.each([
    'checkoutCommit',
    'cherryPick',
    'getBranchBase',
    'getCommitFileDiff',
    'getCommitFiles',
    'getConflictDetails',
    'getGitLog',
    'getGitRangeDiff',
    'getGitRangeFiles',
    'getGlobalGitIdentity',
    'merge',
    'rebase',
    'resetToCommit',
    'revertCommit',
  ] as const)('implements %s', async (operation) => {
    const { createWebGitAPI } = await import('./git');

    expect(typeof createWebGitAPI()[operation]).toBe('function');
  });
});
