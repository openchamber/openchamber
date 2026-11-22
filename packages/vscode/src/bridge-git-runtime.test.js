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
  removeWorktree: mock(),
  resolveRepositoryPrefix: mock(),
  setGitIdentity: mock(),
};

// OpenCode answers the location list with no running locations and every eviction with 204.
const fetchMock = mock(async (input, init) => (
  new Request(input, init).method === 'GET' ? Response.json([]) : new Response(null, { status: 204 })
));
const evictedDirectories = () => fetchMock.mock.calls
  .map(([input, init]) => new Request(input, init))
  .filter((request) => request.method === 'DELETE')
  .map((request) => new URL(request.url).searchParams.get('location[directory]'));
globalThis.fetch = fetchMock;

mock.module('./gitService', () => gitService);

const { handleStandardGitBridgeMessage } = await import('./bridge-git-runtime');

describe('bridge git runtime repository prefix', () => {
  it('answers where the directory sits inside its checkout', async () => {
    gitService.resolveRepositoryPrefix.mockReset();
    gitService.resolveRepositoryPrefix.mockResolvedValue('ai');

    const response = await handleStandardGitBridgeMessage({ id: '1', type: 'api:git/repository-prefix', payload: { directory: '/repo/ai' } });

    expect(response).toEqual({ id: '1', type: 'api:git/repository-prefix', success: true, data: 'ai' });
    expect(gitService.resolveRepositoryPrefix).toHaveBeenCalledWith('/repo/ai');
  });

  it('rejects a request without a directory before reaching git', async () => {
    gitService.resolveRepositoryPrefix.mockReset();

    const response = await handleStandardGitBridgeMessage({ id: '1', type: 'api:git/repository-prefix', payload: {} });

    expect(response?.success).toBe(false);
    expect(gitService.resolveRepositoryPrefix).not.toHaveBeenCalled();
  });
});

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
    gitService.removeWorktree.mockReset();
    fetchMock.mockClear();
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
    }));
  });

  it('disposes the removed worktree instance through the active runtime on DELETE', async () => {
    gitService.removeWorktree.mockResolvedValue(true);

    const response = await handleStandardGitBridgeMessage({
      id: 'remove-worktree',
      type: 'api:git/worktrees',
      payload: {
        directory: '/repo',
        method: 'DELETE',
        body: { directory: '/repo/wt', deleteLocalBranch: true },
      },
    }, {
      manager: {
        getApiUrl: () => 'http://opencode.test',
        getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test' }),
      },
    });

    expect(response).toEqual({
      id: 'remove-worktree',
      type: 'api:git/worktrees',
      success: true,
      data: { success: true },
    });
    expect(gitService.removeWorktree).toHaveBeenCalledWith('/repo', expect.objectContaining({
      directory: '/repo/wt',
      deleteLocalBranch: true,
    }));

    const disposeInstance = gitService.removeWorktree.mock.calls[0][1].disposeInstance;
    await disposeInstance('/repo/wt');

    const evictions = fetchMock.mock.calls
      .map(([input, init]) => new Request(input, init))
      .filter((request) => request.method === 'DELETE');
    expect(evictions).toHaveLength(1);
    // OpenCode 2's location eviction; the v1 /instance/dispose route is gone.
    const url = new URL(evictions[0].url);
    expect(url.origin + url.pathname).toBe('http://opencode.test/api/debug/location');
    expect(url.searchParams.get('location[directory]')).toBe('/repo/wt');
    expect(evictions[0].headers.get('authorization')).toBe('Bearer test');
  });

  it('evicts every running location inside the removed worktree, such as a project folder', async () => {
    gitService.removeWorktree.mockResolvedValue(true);
    await handleStandardGitBridgeMessage({
      id: 'remove-worktree',
      type: 'api:git/worktrees',
      payload: { directory: '/repo/ai', method: 'DELETE', body: { directory: '/repo/wt' } },
    }, { manager: { getApiUrl: () => 'http://opencode.test', getOpenCodeAuthHeaders: () => ({}) } });

    fetchMock.mockImplementationOnce(async () => Response.json([
      { directory: '/repo' },
      { directory: '/repo/ai' },
      { directory: '/repo/wt/ai' },
      { directory: '/repo/wt-other/ai' },
    ]));
    const disposeInstance = gitService.removeWorktree.mock.calls[0][1].disposeInstance;
    await disposeInstance('/repo/wt');

    expect(evictedDirectories().sort()).toEqual(['/repo/wt', '/repo/wt/ai']);
  });

  it('still evicts the worktree root when the location list cannot be read, and reports the failure', async () => {
    gitService.removeWorktree.mockResolvedValue(true);
    await handleStandardGitBridgeMessage({
      id: 'remove-worktree',
      type: 'api:git/worktrees',
      payload: { directory: '/repo', method: 'DELETE', body: { directory: '/repo/wt' } },
    }, { manager: { getApiUrl: () => 'http://opencode.test', getOpenCodeAuthHeaders: () => ({}) } });

    fetchMock.mockImplementationOnce(async () => Response.json({ name: 'BadRequest', data: { message: 'List unavailable' } }, { status: 400 }));
    const disposeInstance = gitService.removeWorktree.mock.calls[0][1].disposeInstance;
    await expect(disposeInstance('/repo/wt')).rejects.toThrow('List unavailable');
    expect(evictedDirectories()).toEqual(['/repo/wt']);
  });

  it('fails disposal when the managed runtime has no API URL', async () => {
    gitService.removeWorktree.mockResolvedValue(true);

    await handleStandardGitBridgeMessage({
      id: 'remove-worktree',
      type: 'api:git/worktrees',
      payload: {
        directory: '/repo',
        method: 'DELETE',
        body: { directory: '/repo/wt' },
      },
    }, { manager: { getApiUrl: () => null, getOpenCodeAuthHeaders: () => ({}) } });

    const disposeInstance = gitService.removeWorktree.mock.calls[0][1].disposeInstance;
    await expect(disposeInstance('/repo/wt')).rejects.toThrow('OpenCode API URL is not available');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('bridge git runtime identity', () => {
  const identityRequest = {
    id: 'identity',
    type: 'api:git/identity',
    payload: { directory: '/repo', method: 'POST', userName: 'Alice', userEmail: 'alice@example.com' },
  };

  it('does not answer success for an identity write the service reported as failed', async () => {
    gitService.setGitIdentity.mockReset();
    gitService.setGitIdentity.mockResolvedValue({ success: false });

    const response = await handleStandardGitBridgeMessage(identityRequest);

    expect(response).toEqual({
      id: 'identity',
      type: 'api:git/identity',
      success: false,
      data: { success: false },
    });
  });

  it('answers success for an applied identity', async () => {
    gitService.setGitIdentity.mockReset();
    gitService.setGitIdentity.mockResolvedValue({ success: true });

    const response = await handleStandardGitBridgeMessage(identityRequest);

    expect(response).toEqual({
      id: 'identity',
      type: 'api:git/identity',
      success: true,
      data: { success: true },
    });
  });
});
