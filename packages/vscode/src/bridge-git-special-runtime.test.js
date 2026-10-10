import { beforeEach, describe, expect, it, mock } from 'bun:test';

const gitService = {
  getGitRangeFiles: mock(),
  getGitRangeDiff: mock(),
  getGitStatus: mock(),
  getGitLog: mock(),
  getGitDiff: mock(),
};

const sdkClient = {
  model: {
    list: mock(),
  },
  generate: {
    text: mock(),
  },
  agent: {
    get: mock(),
  },
};

const make = mock(() => sdkClient);
const rawFetch = mock(async () => {
  throw new Error('raw fetch should not be used');
});

mock.module('./gitService', () => gitService);
mock.module('@opencode/client', () => ({ OpenCode: { make } }));

const { handleSpecialGitBridgeMessage, resetBridgeGitModelCatalogForTest, setUnavailableRetryDelaysForTest } = await import('./bridge-git-special-runtime');

describe('bridge git special runtime', () => {
  beforeEach(() => {
    resetBridgeGitModelCatalogForTest();
    gitService.getGitRangeFiles.mockReset();
    gitService.getGitRangeDiff.mockReset();
    sdkClient.model.list.mockReset();
    sdkClient.generate.text.mockReset();
    sdkClient.agent.get.mockReset();
    make.mockReset();
    rawFetch.mockClear();

    globalThis.fetch = rawFetch;
    make.mockImplementation(() => sdkClient);
    gitService.getGitRangeFiles.mockImplementation(async () => ['src/a.ts']);
    gitService.getGitRangeDiff.mockImplementation(async () => ({ diff: 'diff --git a/src/a.ts b/src/a.ts\n+new line' }));
    sdkClient.model.list.mockImplementation(async () => ({
      location: { directory: '/repo', project: { id: 'p', directory: '/repo', canonical: '/repo' } },
      data: [{ providerID: 'anthropic', id: 'claude-sonnet-4-5' }],
    }));
    sdkClient.generate.text.mockImplementation(async () => ({
      text: '{"title":"PR title","body":"PR body"}',
    }));
    // A location with no configured title agent answers 404, the same shape
    // the server's small-model client treats as "nothing configured".
    sdkClient.agent.get.mockImplementation(async () => {
      const error = new Error('agent not found');
      error.status = 404;
      throw error;
    });
  });

  it('generates a commit message for the changed files through the OpenCode generate route', async () => {
    gitService.getGitStatus.mockImplementation(async () => ({ files: [{ path: 'src/a.ts', index: ' ', working_dir: 'M' }] }));
    gitService.getGitLog.mockImplementation(async () => ({ all: [{ message: 'fix(ui): earlier change' }] }));
    gitService.getGitDiff.mockImplementation(async () => ({ kind: 'diff', diff: 'diff --git a/src/a.ts b/src/a.ts\n+new line', submodule: null }));
    sdkClient.generate.text.mockImplementation(async () => ({ text: '{"subject":"feat: add a line","highlights":["adds a line"]}' }));

    const response = await handleSpecialGitBridgeMessage({
      id: 'c1',
      type: 'api:git/commit-message',
      payload: { directory: '/repo' },
    }, { manager: { getApiUrl: () => 'http://opencode.test', getOpenCodeAuthHeaders: () => ({}) } }, {
      readSettings: () => ({}),
      execGit: mock(),
      readPromptOverrides: () => ({}),
    });

    expect(response).toEqual({
      id: 'c1',
      type: 'api:git/commit-message',
      success: true,
      data: { message: { subject: 'feat: add a line', highlights: ['adds a line'] } },
    });
    expect(sdkClient.generate.text).toHaveBeenCalledTimes(1);
    expect(sdkClient.generate.text.mock.calls[0][0].prompt).toContain('+new line');
  });

  it('generates PR descriptions through the OpenCode generate route', async () => {
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
    expect(make).toHaveBeenCalledWith({
      baseUrl: 'http://opencode.test',
      headers: { Authorization: 'Bearer test', 'x-opencode-directory': encodeURIComponent('/repo') },
    });
    expect(sdkClient.model.list).toHaveBeenCalled();
    expect(sdkClient.generate.text).toHaveBeenCalledWith(
      expect.objectContaining({ model: { id: 'claude-sonnet-4-5', providerID: 'anthropic' } }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('uses the title agent model when no request or override model is set', async () => {
    gitService.getGitStatus.mockImplementation(async () => ({ files: [{ path: 'src/a.ts', index: ' ', working_dir: 'M' }] }));
    gitService.getGitLog.mockImplementation(async () => ({ all: [{ message: 'fix: earlier change' }] }));
    gitService.getGitDiff.mockImplementation(async () => ({ kind: 'diff', diff: 'diff --git a/src/a.ts b/src/a.ts\n+new line', submodule: null }));
    sdkClient.agent.get.mockImplementation(async () => ({ data: { model: { providerID: 'sidecar', id: 'tiny-model' } } }));
    sdkClient.model.list.mockImplementation(async () => ({ data: [{ providerID: 'sidecar', id: 'tiny-model' }] }));
    sdkClient.generate.text.mockImplementation(async () => ({ text: '{"subject":"feat: add a line","highlights":["adds a line"]}' }));

    const response = await handleSpecialGitBridgeMessage({
      id: 't1',
      type: 'api:git/commit-message',
      payload: { directory: '/repo' },
    }, { manager: { getApiUrl: () => 'http://opencode.test', getOpenCodeAuthHeaders: () => ({}) } }, {
      readSettings: () => ({}),
      execGit: mock(),
      readPromptOverrides: () => ({}),
    });

    expect(response.success).toBe(true);
    expect(sdkClient.generate.text.mock.calls[0][0].model).toEqual({ id: 'tiny-model', providerID: 'sidecar' });
  });

  it('scopes the catalog, agent, and generate reads to the flow directory', async () => {
    await handleSpecialGitBridgeMessage({
      id: 's1',
      type: 'api:git/pr-description',
      payload: { directory: '/repo', base: 'main', head: 'feature' },
    }, { manager: { getApiUrl: () => 'http://opencode.test', getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test' }) } }, {
      readSettings: () => ({}),
      execGit: mock(),
    });

    expect(make.mock.calls.length).toBeGreaterThan(0);
    expect(make.mock.calls.every((call) => call[0].headers['x-opencode-directory'] === encodeURIComponent('/repo'))).toBe(true);
  });

  it('reads the model catalog again when the flow directory changes', async () => {
    const prFlow = (id, directory) => handleSpecialGitBridgeMessage({
      id,
      type: 'api:git/pr-description',
      payload: { directory, base: 'main', head: 'feature' },
    }, { manager: { getApiUrl: () => 'http://opencode.test', getOpenCodeAuthHeaders: () => ({}) } }, {
      readSettings: () => ({}),
      execGit: mock(),
    });

    await prFlow('c1', '/repo');
    await prFlow('c2', '/other');

    expect(sdkClient.model.list).toHaveBeenCalledTimes(2);
  });

  it('reports the failure instead of a half-written description when generation fails', async () => {
    sdkClient.generate.text.mockImplementation(async () => {
      throw new Error('model unavailable');
    });

    const response = await handleSpecialGitBridgeMessage({
      id: '2',
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

    expect(response).toEqual({ id: '2', type: 'api:git/pr-description', success: false, error: 'model unavailable' });
  });

  describe('while the model is still loading', () => {
    const unavailable = { _tag: 'InvalidRequestError', message: 'Model unavailable: anthropic/claude-sonnet-4-5' };
    const request = () => handleSpecialGitBridgeMessage({
      id: '3',
      type: 'api:git/pr-description',
      payload: { directory: '/repo', base: 'main', head: 'feature', providerId: 'anthropic', modelId: 'claude-sonnet-4-5' },
    }, {
      manager: { getApiUrl: () => 'http://opencode.test', getOpenCodeAuthHeaders: () => ({}) },
    }, { readSettings: () => ({}), execGit: mock() });

    beforeEach(() => setUnavailableRetryDelaysForTest([1, 1]));

    it('retries with backoff until the model appears', async () => {
      let calls = 0;
      sdkClient.generate.text.mockImplementation(async () => {
        calls += 1;
        if (calls <= 2) throw unavailable;
        return { text: '{"title":"PR title","body":"PR body"}' };
      });

      const response = await request();

      expect(response.success).toBe(true);
      expect(sdkClient.generate.text).toHaveBeenCalledTimes(3);
      setUnavailableRetryDelaysForTest();
    });

    it('gives up once the backoff runs out and never retries other errors', async () => {
      sdkClient.generate.text.mockImplementation(async () => { throw unavailable; });
      expect((await request()).success).toBe(false);
      expect(sdkClient.generate.text).toHaveBeenCalledTimes(3);

      sdkClient.generate.text.mockReset();
      sdkClient.generate.text.mockImplementation(async () => { throw { _tag: 'InvalidRequestError', message: 'Invalid prompt' }; });
      await request();
      expect(sdkClient.generate.text).toHaveBeenCalledTimes(1);
      setUnavailableRetryDelaysForTest();
    });
  });
});
