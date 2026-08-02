import { beforeEach, describe, expect, it, mock } from 'bun:test';

const gitService = {
  stageGitFiles: mock(),
  unstageGitFiles: mock(),
  checkoutCommit: mock(),
  cherryPick: mock(),
  revertCommit: mock(),
  resetToCommit: mock(),
  createWorktree: mock(),
  getWorktreeBootstrapStatus: mock(),
};

mock.module('./gitService', () => gitService);

const { handleStandardGitBridgeMessage } = await import('./bridge-git-runtime');

describe('bridge git runtime index mutations', () => {
  beforeEach(() => {
    gitService.stageGitFiles.mockReset();
    gitService.unstageGitFiles.mockReset();
    gitService.checkoutCommit.mockReset();
    gitService.cherryPick.mockReset();
    gitService.revertCommit.mockReset();
    gitService.resetToCommit.mockReset();
    gitService.createWorktree.mockReset();
    gitService.getWorktreeBootstrapStatus.mockReset();
  });

  it('accepts legacy stage path payloads', async () => {
    const response = await handleStandardGitBridgeMessage({
      id: '1',
      type: 'api:git/stage',
      payload: { directory: '/repo', path: 'a.ts' },
    });

    expect(response).toEqual({ id: '1', type: 'api:git/stage', success: true, data: { success: true } });
    expect(gitService.stageGitFiles).toHaveBeenCalledWith('/repo', ['a.ts']);
  });

  it('accepts bulk stage paths payloads', async () => {
    const response = await handleStandardGitBridgeMessage({
      id: '1',
      type: 'api:git/stage',
      payload: { directory: '/repo', paths: ['a.ts', 'b.ts'] },
    });

    expect(response?.success).toBe(true);
    expect(gitService.stageGitFiles).toHaveBeenCalledWith('/repo', ['a.ts', 'b.ts']);
  });

  it('accepts legacy unstage path payloads', async () => {
    const response = await handleStandardGitBridgeMessage({
      id: '1',
      type: 'api:git/unstage',
      payload: { directory: '/repo', path: 'a.ts' },
    });

    expect(response).toEqual({ id: '1', type: 'api:git/unstage', success: true, data: { success: true } });
    expect(gitService.unstageGitFiles).toHaveBeenCalledWith('/repo', ['a.ts']);
  });

  it('accepts bulk unstage paths payloads', async () => {
    const response = await handleStandardGitBridgeMessage({
      id: '1',
      type: 'api:git/unstage',
      payload: { directory: '/repo', paths: ['a.ts', 'b.ts'] },
    });

    expect(response?.success).toBe(true);
    expect(gitService.unstageGitFiles).toHaveBeenCalledWith('/repo', ['a.ts', 'b.ts']);
  });

  it('rejects invalid path payloads', async () => {
    const response = await handleStandardGitBridgeMessage({
      id: '1',
      type: 'api:git/stage',
      payload: { directory: '/repo', paths: [' ', null] },
    });

    expect(response?.success).toBe(false);
    expect(gitService.stageGitFiles).not.toHaveBeenCalled();
  });

  it('rejects invalid commit hashes before commit actions reach git service', async () => {
    const checkoutResponse = await handleStandardGitBridgeMessage({
      id: '1',
      type: 'api:git/checkout-commit',
      payload: { directory: '/repo', hash: 'HEAD' },
    });
    const cherryPickResponse = await handleStandardGitBridgeMessage({
      id: '2',
      type: 'api:git/cherry-pick',
      payload: { directory: '/repo', hash: '--abort' },
    });
    const revertResponse = await handleStandardGitBridgeMessage({
      id: '3',
      type: 'api:git/revert-commit',
      payload: { directory: '/repo', hash: '--continue' },
    });
    const resetResponse = await handleStandardGitBridgeMessage({
      id: '4',
      type: 'api:git/reset-to-commit',
      payload: { directory: '/repo', hash: '--hard', mode: 'mixed' },
    });

    expect(checkoutResponse).toEqual({ id: '1', type: 'api:git/checkout-commit', success: false, error: 'Invalid commit hash' });
    expect(cherryPickResponse).toEqual({ id: '2', type: 'api:git/cherry-pick', success: false, error: 'Invalid commit hash' });
    expect(revertResponse).toEqual({ id: '3', type: 'api:git/revert-commit', success: false, error: 'Invalid commit hash' });
    expect(resetResponse).toEqual({ id: '4', type: 'api:git/reset-to-commit', success: false, error: 'Invalid commit hash' });
    expect(gitService.checkoutCommit).not.toHaveBeenCalled();
    expect(gitService.cherryPick).not.toHaveBeenCalled();
    expect(gitService.revertCommit).not.toHaveBeenCalled();
    expect(gitService.resetToCommit).not.toHaveBeenCalled();
  });

  it('preserves bootstrap phases in status responses', async () => {
    const bootstrapStatus = {
      status: 'pending',
      phase: 'git-ready',
      error: null,
      updatedAt: 123,
    };
    gitService.getWorktreeBootstrapStatus.mockResolvedValue(bootstrapStatus);

    const response = await handleStandardGitBridgeMessage({
      id: 'bootstrap-status',
      type: 'api:git/worktrees/bootstrap-status',
      payload: { directory: '/repo-worktree' },
    });

    expect(response).toEqual({
      id: 'bootstrap-status',
      type: 'api:git/worktrees/bootstrap-status',
      success: true,
      data: bootstrapStatus,
    });
    expect(gitService.getWorktreeBootstrapStatus).toHaveBeenCalledWith('/repo-worktree');
  });

  it('preserves the directory-created phase in fast create responses', async () => {
    const created = {
      head: '',
      name: 'feature',
      branch: 'openchamber/feature',
      path: '/repo-worktree',
      directoryCreated: true,
      bootstrapStatus: {
        status: 'pending',
        phase: 'directory-created',
        error: null,
        updatedAt: 123,
      },
    };
    gitService.createWorktree.mockResolvedValue(created);

    const response = await handleStandardGitBridgeMessage({
      id: 'create-worktree',
      type: 'api:git/worktrees',
      payload: {
        directory: '/repo',
        method: 'POST',
        worktreeName: 'feature',
        returnAfterDirectoryCreated: true,
      },
    });

    expect(response).toEqual({
      id: 'create-worktree',
      type: 'api:git/worktrees',
      success: true,
      data: created,
    });
    expect(gitService.createWorktree).toHaveBeenCalledWith('/repo', expect.objectContaining({
      returnAfterDirectoryCreated: true,
    }), { projectCommandRuntime: expect.objectContaining({ loadStartCommand: expect.any(Function) }) });
  });

  it('passes manager-backed project command runtime to worktree creation', async () => {
    gitService.createWorktree.mockResolvedValue({ path: '/repo-worktree' });
    const manager = {
      getApiUrl: mock(() => 'http://127.0.0.1:4096'),
      getOpenCodeAuthHeaders: mock(() => ({ Authorization: 'Bearer test-token' })),
    };

    const response = await handleStandardGitBridgeMessage({
      id: 'create-worktree',
      type: 'api:git/worktrees',
      payload: { directory: '/repo', method: 'POST' },
    }, { manager });

    expect(response?.success).toBe(true);
    expect(gitService.createWorktree).toHaveBeenCalledWith('/repo', expect.objectContaining({
      directory: '/repo',
      method: 'POST',
    }), { projectCommandRuntime: expect.objectContaining({ loadStartCommand: expect.any(Function) }) });
  });
});
