import { beforeEach, describe, expect, it, mock } from 'bun:test';

const gitService = {
  stageGitFiles: mock(),
  unstageGitFiles: mock(),
  createTag: mock(),
  checkoutCommit: mock(),
  cherryPick: mock(),
  revertCommit: mock(),
  resetToCommit: mock(),
  createWorktree: mock(),
  getWorktreeBootstrapStatus: mock(),
  getGitHistoryRefs: mock(),
  getGitHistory: mock(),
  getGitHistoryMergeBase: mock(),
  getCommitFiles: mock(),
  getCommitFileDiff: mock(),
};

mock.module('./gitService', () => gitService);

const { handleStandardGitBridgeMessage } = await import('./bridge-git-runtime');

describe('bridge git runtime index mutations', () => {
  beforeEach(() => {
    gitService.stageGitFiles.mockReset();
    gitService.unstageGitFiles.mockReset();
    gitService.createTag.mockReset();
    gitService.checkoutCommit.mockReset();
    gitService.cherryPick.mockReset();
    gitService.revertCommit.mockReset();
    gitService.resetToCommit.mockReset();
    gitService.createWorktree.mockReset();
    gitService.getWorktreeBootstrapStatus.mockReset();
    gitService.getGitHistoryRefs.mockReset();
    gitService.getGitHistory.mockReset();
    gitService.getGitHistoryMergeBase.mockReset();
    gitService.getCommitFiles.mockReset();
    gitService.getCommitFileDiff.mockReset();
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

  it('accepts 64-char commit hashes at the bridge boundary for commit actions', async () => {
    gitService.checkoutCommit.mockResolvedValue({ success: true });
    gitService.cherryPick.mockResolvedValue({ success: true, conflict: false });
    gitService.revertCommit.mockResolvedValue({ success: true, conflict: false });
    gitService.resetToCommit.mockResolvedValue({ success: true });
    const hash = 'a'.repeat(64);

    expect(await handleStandardGitBridgeMessage({
      id: '1',
      type: 'api:git/checkout-commit',
      payload: { directory: '/repo', hash },
    })).toEqual({ id: '1', type: 'api:git/checkout-commit', success: true, data: { success: true } });
    expect(await handleStandardGitBridgeMessage({
      id: '2',
      type: 'api:git/cherry-pick',
      payload: { directory: '/repo', hash },
    })).toEqual({ id: '2', type: 'api:git/cherry-pick', success: true, data: { success: true, conflict: false } });
    expect(await handleStandardGitBridgeMessage({
      id: '3',
      type: 'api:git/revert-commit',
      payload: { directory: '/repo', hash },
    })).toEqual({ id: '3', type: 'api:git/revert-commit', success: true, data: { success: true, conflict: false } });
    expect(await handleStandardGitBridgeMessage({
      id: '4',
      type: 'api:git/reset-to-commit',
      payload: { directory: '/repo', hash, mode: 'mixed' },
    })).toEqual({ id: '4', type: 'api:git/reset-to-commit', success: true, data: { success: true } });
  });

  it('requires full object ids for VS Code tag and commit file payloads', async () => {
    const tagResponse = await handleStandardGitBridgeMessage({
      id: 'tag',
      type: 'api:git/tags',
      payload: { directory: '/repo', method: 'POST', name: 'v1.2.3', commitHash: 'abc1234' },
    });
    expect(tagResponse).toEqual({ id: 'tag', type: 'api:git/tags', success: false, error: 'commitHash must be a full commit SHA' });

    const metadataResponse = await handleStandardGitBridgeMessage({
      id: 'files',
      type: 'api:git/commit-files',
      payload: { directory: '/repo', hash: 'abc1234', parentHash: 'd'.repeat(64) },
    });
    expect(metadataResponse).toEqual({ id: 'files', type: 'api:git/commit-files', success: false, error: 'hash must be a full commit SHA' });

    const previewResponse = await handleStandardGitBridgeMessage({
      id: 'diff',
      type: 'api:git/commit-file-diff',
      payload: { directory: '/repo', hash: 'a'.repeat(64), parentHash: 'bad-parent', originalPath: 'a.ts', modifiedPath: 'b.ts' },
    });
    expect(previewResponse).toEqual({ id: 'diff', type: 'api:git/commit-file-diff', success: false, error: 'parentHash must be a full commit SHA or null' });
    expect(gitService.createTag).not.toHaveBeenCalled();
    expect(gitService.getCommitFiles).not.toHaveBeenCalled();
    expect(gitService.getCommitFileDiff).not.toHaveBeenCalled();
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
    }));
  });

  it('forwards git history refs requests to the git service', async () => {
    const refsResponse = {
      refs: [{ id: 'refs/heads/main', name: 'main', revision: 'abc1234', kind: 'local', category: 'branches' }],
      current: null,
      upstream: null,
      base: null,
      snapshot: 'refs/heads/main:abc1234',
    };
    gitService.getGitHistoryRefs.mockResolvedValue(refsResponse);

    const response = await handleStandardGitBridgeMessage({
      id: 'history-refs',
      type: 'api:git/history/refs',
      payload: { directory: '/repo' },
    });

    expect(response).toEqual({
      id: 'history-refs',
      type: 'api:git/history/refs',
      success: true,
      data: refsResponse,
    });
    expect(gitService.getGitHistoryRefs).toHaveBeenCalledWith('/repo');
  });

  it('parses git history payloads at the bridge boundary', async () => {
    gitService.getGitHistory.mockResolvedValue({
      items: [],
      nextCursor: null,
      hasMore: false,
      refsSnapshot: 'snapshot',
    });

    const invalidRefsResponse = await handleStandardGitBridgeMessage({
      id: 'invalid-history-refs',
      type: 'api:git/history',
      payload: { directory: '/repo', refs: 'HEAD' },
    });
    expect(invalidRefsResponse).toEqual({
      id: 'invalid-history-refs',
      type: 'api:git/history',
      success: false,
      error: 'refs must be an array of strings',
    });
    expect(gitService.getGitHistory).not.toHaveBeenCalled();

    const invalidLimitResponse = await handleStandardGitBridgeMessage({
      id: 'invalid-history-limit',
      type: 'api:git/history',
      payload: { directory: '/repo', refs: ['HEAD'], limit: '2' },
    });
    expect(invalidLimitResponse).toEqual({
      id: 'invalid-history-limit',
      type: 'api:git/history',
      success: false,
      error: 'limit must be a number',
    });
    expect(gitService.getGitHistory).not.toHaveBeenCalled();

    const validResponse = await handleStandardGitBridgeMessage({
      id: 'valid-history',
      type: 'api:git/history',
      payload: { directory: '/repo', refs: ['HEAD', 'refs/heads/main'], cursor: 'cursor-token', limit: 25 },
    });
    expect(validResponse?.success).toBe(true);
    expect(gitService.getGitHistory).toHaveBeenCalledWith('/repo', {
      refs: ['HEAD', 'refs/heads/main'],
      cursor: 'cursor-token',
      limit: 25,
    });

    const ambiguousResponse = await handleStandardGitBridgeMessage({
      id: 'ambiguous-history',
      type: 'api:git/history',
      payload: { directory: '/repo', all: true, refs: ['HEAD'] },
    });
    expect(ambiguousResponse).toEqual({
      id: 'ambiguous-history',
      type: 'api:git/history',
      success: false,
      error: 'all cannot be combined with explicit refs',
    });

    const allResponse = await handleStandardGitBridgeMessage({
      id: 'all-history',
      type: 'api:git/history',
      payload: { directory: '/repo', all: true, limit: 25 },
    });
    expect(allResponse?.success).toBe(true);
    expect(gitService.getGitHistory).toHaveBeenCalledWith('/repo', {
      all: true,
      cursor: undefined,
      limit: 25,
    });
  });

  it('forwards structured commit file requests to the git service', async () => {
    gitService.getCommitFiles.mockResolvedValue({
      files: [
        {
          path: 'new-name.ts',
          originalPath: 'old-name.ts',
          status: 'R',
          kind: 'file',
          originalObjectId: 'aaaa',
          objectId: 'bbbb',
          insertions: 1,
          deletions: 1,
          isBinary: false,
        },
      ],
    });

    const response = await handleStandardGitBridgeMessage({
      id: 'commit-files',
      type: 'api:git/commit-files',
      payload: {
        directory: '/repo',
        hash: 'a'.repeat(64),
        parentHash: 'b'.repeat(64),
      },
    });

    expect(response).toEqual({
      id: 'commit-files',
      type: 'api:git/commit-files',
      success: true,
      data: {
        files: [
          {
            path: 'new-name.ts',
            originalPath: 'old-name.ts',
            status: 'R',
            kind: 'file',
            originalObjectId: 'aaaa',
            objectId: 'bbbb',
            insertions: 1,
            deletions: 1,
            isBinary: false,
          },
        ],
      },
    });
    expect(gitService.getCommitFiles).toHaveBeenCalledWith('/repo', {
      commitHash: 'a'.repeat(64),
      parentHash: 'b'.repeat(64),
    });
  });

  it('preserves commit file lookup failures for the bridge caller', async () => {
    gitService.getCommitFiles.mockRejectedValue(new Error('fatal: bad object missing-parent'));

    await expect(handleStandardGitBridgeMessage({
      id: 'commit-files-error',
      type: 'api:git/commit-files',
      payload: {
        directory: '/repo',
        hash: 'a'.repeat(64),
        parentHash: 'b'.repeat(64),
      },
    })).rejects.toThrow('fatal: bad object missing-parent');
  });

  it('forwards structured commit preview requests and preserves too-large responses', async () => {
    gitService.getCommitFileDiff.mockResolvedValue({
      status: 'too-large',
      totalBytes: 8388609,
      maxBytes: 8388608,
    });

    const response = await handleStandardGitBridgeMessage({
      id: 'commit-preview',
      type: 'api:git/commit-file-diff',
      payload: {
        directory: '/repo',
        hash: 'a'.repeat(64),
        parentHash: 'b'.repeat(64),
        originalPath: 'old-name.ts',
        modifiedPath: 'new-name.ts',
      },
    });

    expect(response).toEqual({
      id: 'commit-preview',
      type: 'api:git/commit-file-diff',
      success: true,
      data: {
        status: 'too-large',
        totalBytes: 8388609,
        maxBytes: 8388608,
      },
    });
    expect(gitService.getCommitFileDiff).toHaveBeenCalledWith('/repo', {
      commitHash: 'a'.repeat(64),
      parentHash: 'b'.repeat(64),
      originalPath: 'old-name.ts',
      modifiedPath: 'new-name.ts',
    });
  });

  it('parses merge-base payloads at the bridge boundary', async () => {
    gitService.getGitHistoryMergeBase.mockResolvedValue({ mergeBase: 'abc1234' });

    const invalidResponse = await handleStandardGitBridgeMessage({
      id: 'invalid-merge-base',
      type: 'api:git/history/merge-base',
      payload: { directory: '/repo', refs: [null, 'HEAD'] },
    });
    expect(invalidResponse).toEqual({
      id: 'invalid-merge-base',
      type: 'api:git/history/merge-base',
      success: false,
      error: 'refs must be an array of strings',
    });
    expect(gitService.getGitHistoryMergeBase).not.toHaveBeenCalled();

    const validResponse = await handleStandardGitBridgeMessage({
      id: 'valid-merge-base',
      type: 'api:git/history/merge-base',
      payload: { directory: '/repo', refs: ['HEAD', 'refs/heads/main'] },
    });

    expect(validResponse).toEqual({
      id: 'valid-merge-base',
      type: 'api:git/history/merge-base',
      success: true,
      data: { mergeBase: 'abc1234' },
    });
    expect(gitService.getGitHistoryMergeBase).toHaveBeenCalledWith('/repo', {
      refs: ['HEAD', 'refs/heads/main'],
    });
  });
});
