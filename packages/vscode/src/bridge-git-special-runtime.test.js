import { beforeEach, describe, expect, it, mock } from 'bun:test';

const gitService = {
  getGitRangeFiles: mock(),
  getGitRangeDiff: mock(),
  getGitStatus: mock(),
  getGitDiff: mock(),
  getGitLog: mock(),
};

const sdkClient = {
  v2: {
    model: {
      list: mock(),
    },
  },
  session: {
    create: mock(),
    promptAsync: mock(),
    messages: mock(),
    delete: mock(),
  },
};

const createOpencodeClient = mock(() => sdkClient);
const rawFetch = mock(async () => {
  throw new Error('raw fetch should not be used');
});

mock.module('./gitService', () => gitService);
mock.module('@opencode-ai/sdk/v2', () => ({ createOpencodeClient }));
mock.module('./bridge-settings-runtime', () => ({
  readMagicPromptOverrides: () => ({ version: 1, overrides: {} }),
}));

const { handleSpecialGitBridgeMessage, resetBridgeGitModelCatalogCache } = await import('./bridge-git-special-runtime');

describe('bridge git special runtime', () => {
  beforeEach(() => {
    resetBridgeGitModelCatalogCache();
    gitService.getGitRangeFiles.mockReset();
    gitService.getGitRangeDiff.mockReset();
    gitService.getGitStatus.mockReset();
    gitService.getGitDiff.mockReset();
    gitService.getGitLog.mockReset();
    sdkClient.v2.model.list.mockReset();
    sdkClient.session.create.mockReset();
    sdkClient.session.promptAsync.mockReset();
    sdkClient.session.messages.mockReset();
    sdkClient.session.delete.mockReset();
    createOpencodeClient.mockReset();
    rawFetch.mockClear();

    globalThis.fetch = rawFetch;
    createOpencodeClient.mockImplementation(() => sdkClient);
    gitService.getGitRangeFiles.mockImplementation(async () => ['src/a.ts']);
    gitService.getGitRangeDiff.mockImplementation(async () => ({ diff: 'diff --git a/src/a.ts b/src/a.ts\n+new line' }));
    gitService.getGitStatus.mockImplementation(async () => ({
      files: [{ path: 'src/a.ts', index: 'M', working_dir: ' ' }],
    }));
    gitService.getGitDiff.mockImplementation(async () => ({
      diff: 'diff --git a/src/a.ts b/src/a.ts\n+new line',
    }));
    gitService.getGitLog.mockImplementation(async () => ({
      all: [{ message: 'feat: previous change' }],
      latest: null,
      total: 1,
    }));
    sdkClient.v2.model.list.mockImplementation(async () => ({
      data: {
        location: { directory: '/repo' },
        data: [{ providerID: 'anthropic', id: 'claude-sonnet-4-5' }],
      },
      error: undefined,
    }));
    sdkClient.session.create.mockImplementation(async () => ({
      data: { id: 'ses_1' },
      error: undefined,
    }));
    sdkClient.session.promptAsync.mockImplementation(async () => ({ data: true, error: undefined }));
    sdkClient.session.messages.mockImplementation(async () => ({
      data: [{
        info: { role: 'assistant', finish: 'stop' },
        parts: [{ type: 'text', text: '{"title":"PR title","body":"PR body"}' }],
      }],
      error: undefined,
    }));
    sdkClient.session.delete.mockImplementation(async () => ({ data: true, error: undefined }));
  });

  it('generates PR descriptions through the OpenCode SDK session flow', async () => {
    const response = await handleSpecialGitBridgeMessage({
      id: '1',
      type: 'api:git/pr-description',
      payload: {
        directory: '/repo',
        base: 'main',
        head: 'feature',
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-5',
      },
    }, {
      manager: {
        getApiUrl: () => 'http://opencode.test',
        getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test' }),
      },
    }, {
      readSettings: () => ({}),
      execGit: mock(),
    });

    expect(response).toEqual({
      id: '1',
      type: 'api:git/pr-description',
      success: true,
      data: { title: 'PR title', body: 'PR body' },
    });
    expect(rawFetch).not.toHaveBeenCalled();
    expect(createOpencodeClient).toHaveBeenCalledWith({
      baseUrl: 'http://opencode.test',
      headers: { Authorization: 'Bearer test' },
    });
    expect(sdkClient.v2.model.list).toHaveBeenCalled();
    expect(sdkClient.session.create).toHaveBeenCalledWith({
      directory: '/repo',
      title: 'Git Generation',
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(sdkClient.session.promptAsync).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'ses_1',
      directory: '/repo',
      model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(sdkClient.session.messages).toHaveBeenCalledWith({
      sessionID: 'ses_1',
      directory: '/repo',
      limit: 10,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(sdkClient.session.delete).toHaveBeenCalledWith({ sessionID: 'ses_1' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('generates commit messages through the OpenCode SDK session flow', async () => {
    sdkClient.session.messages.mockImplementation(async () => ({
      data: [{
        info: { role: 'assistant', finish: 'stop' },
        parts: [{ type: 'text', text: '{"subject":"feat: add scm generate","highlights":["SCM title button"]}' }],
      }],
      error: undefined,
    }));

    const response = await handleSpecialGitBridgeMessage({
      id: '2',
      type: 'api:git/commit-message',
      payload: {
        directory: '/repo',
        files: ['src/a.ts'],
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-5',
      },
    }, {
      manager: {
        getApiUrl: () => 'http://opencode.test',
        getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test' }),
      },
    }, {
      readSettings: () => ({}),
      execGit: mock(),
    });

    expect(response).toEqual({
      id: '2',
      type: 'api:git/commit-message',
      success: true,
      data: {
        message: {
          subject: 'feat: add scm generate',
          highlights: ['SCM title button'],
        },
      },
    });
    expect(sdkClient.session.create).toHaveBeenCalled();
    expect(sdkClient.session.delete).toHaveBeenCalled();
  });

  it('prompts only with the staged diff when a selected file also has unstaged hunks', async () => {
    gitService.getGitStatus.mockImplementation(async () => ({
      files: [{ path: 'src/a.ts', index: 'M', working_dir: 'M' }],
    }));
    gitService.getGitDiff.mockImplementation(async (_directory, _filePath, staged) => ({
      diff: staged
        ? 'diff --git a/src/a.ts b/src/a.ts\n+staged line'
        : 'diff --git a/src/a.ts b/src/a.ts\n+unstaged line',
    }));
    sdkClient.session.messages.mockImplementation(async () => ({
      data: [{
        info: { role: 'assistant', finish: 'stop' },
        parts: [{ type: 'text', text: '{"subject":"feat: add scm generate","highlights":[]}' }],
      }],
      error: undefined,
    }));

    const response = await handleSpecialGitBridgeMessage({
      id: '2b',
      type: 'api:git/commit-message',
      payload: {
        directory: '/repo',
        files: ['src/a.ts'],
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-5',
      },
    }, {
      manager: {
        getApiUrl: () => 'http://opencode.test',
        getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test' }),
      },
    }, {
      readSettings: () => ({}),
      execGit: mock(),
    });

    expect(response?.success).toBe(true);
    expect(gitService.getGitDiff).toHaveBeenCalledWith('/repo', 'src/a.ts', true);
    expect(gitService.getGitDiff).not.toHaveBeenCalledWith('/repo', 'src/a.ts', false);
    const promptText = sdkClient.session.promptAsync.mock.calls[0][0].parts[0].text;
    expect(promptText).toContain('+staged line');
    expect(promptText).not.toContain('+unstaged line');
  });

  it('fails commit generation when no files are available', async () => {
    gitService.getGitStatus.mockImplementation(async () => ({ files: [] }));

    const response = await handleSpecialGitBridgeMessage({
      id: '3',
      type: 'api:git/commit-message',
      payload: { directory: '/repo' },
    }, {
      manager: {
        getApiUrl: () => 'http://opencode.test',
        getOpenCodeAuthHeaders: () => ({}),
      },
    }, {
      readSettings: () => ({}),
      execGit: mock(),
    });

    expect(response).toEqual({
      id: '3',
      type: 'api:git/commit-message',
      success: false,
      error: 'No files provided to generate commit message',
    });
    expect(sdkClient.session.create).not.toHaveBeenCalled();
  });

  it('uses a catalog model when no request model is set and zen is absent', async () => {
    sdkClient.v2.model.list.mockImplementation(async () => ({
      data: {
        location: { directory: '/repo' },
        data: [{ providerID: 'opencode', id: 'ling-3.0-flash-fin-free' }],
      },
      error: undefined,
    }));
    sdkClient.session.messages.mockImplementation(async () => ({
      data: [{
        info: { role: 'assistant', finish: 'stop' },
        parts: [{ type: 'text', text: '{"subject":"feat: add scm generate","highlights":[]}' }],
      }],
      error: undefined,
    }));

    const response = await handleSpecialGitBridgeMessage({
      id: '4',
      type: 'api:git/commit-message',
      payload: { directory: '/repo', files: ['src/a.ts'] },
    }, {
      manager: {
        getApiUrl: () => 'http://opencode.test',
        getOpenCodeAuthHeaders: () => ({}),
      },
    }, {
      readSettings: () => ({}),
      execGit: mock(),
    });

    expect(response?.success).toBe(true);
    expect(sdkClient.session.promptAsync).toHaveBeenCalledWith(expect.objectContaining({
      model: { providerID: 'opencode', modelID: 'ling-3.0-flash-fin-free' },
    }), expect.anything());
  });

  it('uses OpenCode big-pickle when the catalog lookup fails', async () => {
    sdkClient.v2.model.list.mockImplementation(async () => ({
      data: undefined,
      error: new Error('model.list failed'),
    }));
    sdkClient.session.messages.mockImplementation(async () => ({
      data: [{
        info: { role: 'assistant', finish: 'stop' },
        parts: [{ type: 'text', text: '{"subject":"feat: add scm generate","highlights":[]}' }],
      }],
      error: undefined,
    }));

    const response = await handleSpecialGitBridgeMessage({
      id: '4b',
      type: 'api:git/commit-message',
      payload: { directory: '/repo', files: ['src/a.ts'] },
    }, {
      manager: {
        getApiUrl: () => 'http://opencode.test',
        getOpenCodeAuthHeaders: () => ({}),
      },
    }, {
      readSettings: () => ({}),
      execGit: mock(),
    });

    expect(response?.success).toBe(true);
    expect(sdkClient.session.promptAsync).toHaveBeenCalledWith(expect.objectContaining({
      model: { providerID: 'opencode', modelID: 'big-pickle' },
    }), expect.anything());
  });

  it('fails commit generation when the session finishes with an error', async () => {
    sdkClient.session.messages.mockImplementation(async () => ({
      data: [{
        info: { role: 'assistant', finish: 'error', error: 'Provider not found' },
        parts: [],
      }],
      error: undefined,
    }));

    const response = await handleSpecialGitBridgeMessage({
      id: '5',
      type: 'api:git/commit-message',
      payload: {
        directory: '/repo',
        files: ['src/a.ts'],
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-5',
      },
    }, {
      manager: {
        getApiUrl: () => 'http://opencode.test',
        getOpenCodeAuthHeaders: () => ({}),
      },
    }, {
      readSettings: () => ({}),
      execGit: mock(),
    });

    expect(response).toEqual({
      id: '5',
      type: 'api:git/commit-message',
      success: false,
      error: 'Generation failed: Provider not found',
    });
  });
});
