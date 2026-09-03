import { beforeEach, describe, expect, it, mock } from 'bun:test';

const gitExecutionService = {
  stageGitFiles: mock(),
  unstageGitFiles: mock(),
  checkoutCommit: mock(),
  cherryPick: mock(),
  revertCommit: mock(),
  resetToCommit: mock(),
  createWorktree: mock(),
  getWorktreeBootstrapStatus: mock(),
};

mock.module('./git-execution-service', () => gitExecutionService);

const { handleStandardGitBridgeMessage } = await import('./bridge-git-runtime');

describe('bridge git runtime index mutations', () => {
  beforeEach(() => {
    gitExecutionService.stageGitFiles.mockReset();
    gitExecutionService.unstageGitFiles.mockReset();
    gitExecutionService.checkoutCommit.mockReset();
    gitExecutionService.cherryPick.mockReset();
    gitExecutionService.revertCommit.mockReset();
    gitExecutionService.resetToCommit.mockReset();
    gitExecutionService.createWorktree.mockReset();
    gitExecutionService.getWorktreeBootstrapStatus.mockReset();
  });

  it('accepts legacy stage path payloads', async () => {
    const response = await handleStandardGitBridgeMessage({
      id: '1',
      type: 'api:git/stage',
      payload: { directory: '/repo', path: 'a.ts' },
    });

    expect(response).toEqual({ id: '1', type: 'api:git/stage', success: true, data: { success: true } });
    expect(gitExecutionService.stageGitFiles).toHaveBeenCalledWith('/repo', ['a.ts']);
  });

  it('accepts bulk stage paths payloads', async () => {
    const response = await handleStandardGitBridgeMessage({
      id: '1',
      type: 'api:git/stage',
      payload: { directory: '/repo', paths: ['a.ts', 'b.ts'] },
    });

    expect(response?.success).toBe(true);
    expect(gitExecutionService.stageGitFiles).toHaveBeenCalledWith('/repo', ['a.ts', 'b.ts']);
  });

  it('accepts legacy unstage path payloads', async () => {
    const response = await handleStandardGitBridgeMessage({
      id: '1',
      type: 'api:git/unstage',
      payload: { directory: '/repo', path: 'a.ts' },
    });

    expect(response).toEqual({ id: '1', type: 'api:git/unstage', success: true, data: { success: true } });
    expect(gitExecutionService.unstageGitFiles).toHaveBeenCalledWith('/repo', ['a.ts']);
  });

  it('accepts bulk unstage paths payloads', async () => {
    const response = await handleStandardGitBridgeMessage({
      id: '1',
      type: 'api:git/unstage',
      payload: { directory: '/repo', paths: ['a.ts', 'b.ts'] },
    });

    expect(response?.success).toBe(true);
    expect(gitExecutionService.unstageGitFiles).toHaveBeenCalledWith('/repo', ['a.ts', 'b.ts']);
  });

  it('rejects invalid path payloads', async () => {
    const response = await handleStandardGitBridgeMessage({
      id: '1',
      type: 'api:git/stage',
      payload: { directory: '/repo', paths: [' ', null] },
    });

    expect(response?.success).toBe(false);
    expect(gitExecutionService.stageGitFiles).not.toHaveBeenCalled();
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
    expect(gitExecutionService.checkoutCommit).not.toHaveBeenCalled();
    expect(gitExecutionService.cherryPick).not.toHaveBeenCalled();
    expect(gitExecutionService.revertCommit).not.toHaveBeenCalled();
    expect(gitExecutionService.resetToCommit).not.toHaveBeenCalled();
  });

  it('preserves bootstrap phases in status responses', async () => {
    const bootstrapStatus = {
      status: 'pending',
      phase: 'git-ready',
      error: null,
      updatedAt: 123,
    };
    gitExecutionService.getWorktreeBootstrapStatus.mockResolvedValue(bootstrapStatus);

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
    expect(gitExecutionService.getWorktreeBootstrapStatus).toHaveBeenCalledWith('/repo-worktree');
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
    gitExecutionService.createWorktree.mockResolvedValue(created);

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
    expect(gitExecutionService.createWorktree).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({
        returnAfterDirectoryCreated: true,
      }),
    );
  });
});
