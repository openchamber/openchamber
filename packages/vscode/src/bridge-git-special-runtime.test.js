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
  experimental: {
    generate: {
      text: mock(),
    },
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
    sdkClient.experimental.generate.text.mockReset();
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
    sdkClient.experimental.generate.text.mockImplementation(async () => ({
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
    sdkClient.experimental.generate.text.mockImplementation(async () => ({ text: '{"subject":"feat: add a line","highlights":["adds a line"]}' }));

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
    expect(sdkClient.experimental.generate.text).toHaveBeenCalledTimes(1);
    expect(sdkClient.experimental.generate.text.mock.calls[0][0].prompt).toContain('+new line');
  });

  it('reads the prompts of the directory it commits in and uses an empty instructions override as written', async () => {
    gitService.getGitStatus.mockImplementation(async () => ({ files: [{ path: 'src/a.ts', index: ' ', working_dir: 'M' }] }));
    gitService.getGitLog.mockImplementation(async () => ({ all: [] }));
    gitService.getGitDiff.mockImplementation(async () => ({ kind: 'diff', diff: 'diff --git a/src/a.ts b/src/a.ts\n+new line', submodule: null }));
    sdkClient.experimental.generate.text.mockImplementation(async () => ({ text: '{"subject":"feat: add a line","highlights":[]}' }));
    const readPromptOverrides = mock(async () => ({
      'git.commit.generate.visible': 'Project visible',
      'git.commit.generate.instructions': '',
    }));

    const response = await handleSpecialGitBridgeMessage({
      id: 'p1',
      type: 'api:git/commit-message',
      payload: { directory: '/repo-b' },
    }, { manager: { getApiUrl: () => 'http://opencode.test', getOpenCodeAuthHeaders: () => ({}) } }, {
      readSettings: () => ({}),
      execGit: mock(),
      readPromptOverrides,
    });

    expect(response.success).toBe(true);
    expect(readPromptOverrides).toHaveBeenCalledWith('/repo-b');
    const prompt = sdkClient.experimental.generate.text.mock.calls[0][0].prompt;
    expect(prompt.startsWith('Project visible\n\n\n\nDiffs of the selected files:')).toBe(true);
    expect(prompt).not.toContain('Return exactly one JSON object');
  });

  it('fails the generation when the prompts cannot be read instead of using the built-in text', async () => {
    const response = await handleSpecialGitBridgeMessage({
      id: 'p2',
      type: 'api:git/commit-message',
      payload: { directory: '/repo' },
    }, { manager: { getApiUrl: () => 'http://opencode.test', getOpenCodeAuthHeaders: () => ({}) } }, {
      readSettings: () => ({}),
      execGit: mock(),
      readPromptOverrides: async () => { throw new Error('Project magic prompts cannot be read: invalid JSON'); },
    });

    expect(response).toEqual({ id: 'p2', type: 'api:git/commit-message', success: false, error: 'Project magic prompts cannot be read: invalid JSON' });
    expect(sdkClient.experimental.generate.text).not.toHaveBeenCalled();
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
    expect(sdkClient.experimental.generate.text).toHaveBeenCalledWith(
      expect.objectContaining({ model: { id: 'claude-sonnet-4-5', providerID: 'anthropic' } }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('uses the title agent model and its thinking variant when no request or override model is set', async () => {
    gitService.getGitStatus.mockImplementation(async () => ({ files: [{ path: 'src/a.ts', index: ' ', working_dir: 'M' }] }));
    gitService.getGitLog.mockImplementation(async () => ({ all: [{ message: 'fix: earlier change' }] }));
    gitService.getGitDiff.mockImplementation(async () => ({ kind: 'diff', diff: 'diff --git a/src/a.ts b/src/a.ts\n+new line', submodule: null }));
    sdkClient.agent.get.mockImplementation(async () => ({
      data: { model: { providerID: 'sidecar', id: 'tiny-model', variant: 'low' } },
    }));
    sdkClient.model.list.mockImplementation(async () => ({
      data: [{ providerID: 'sidecar', id: 'tiny-model', variants: [{ id: 'low' }] }],
    }));
    sdkClient.experimental.generate.text.mockImplementation(async () => ({ text: '{"subject":"feat: add a line","highlights":["adds a line"]}' }));

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
    expect(sdkClient.experimental.generate.text.mock.calls[0][0].model).toEqual({
      id: 'tiny-model',
      providerID: 'sidecar',
      variant: 'low',
    });
  });

  it('skips a title agent model OpenCode lists as disabled, like the server resolver', async () => {
    gitService.getGitStatus.mockImplementation(async () => ({ files: [{ path: 'src/a.ts', index: ' ', working_dir: 'M' }] }));
    gitService.getGitLog.mockImplementation(async () => ({ all: [{ message: 'fix: earlier change' }] }));
    gitService.getGitDiff.mockImplementation(async () => ({ kind: 'diff', diff: 'diff --git a/src/a.ts b/src/a.ts\n+new line', submodule: null }));
    sdkClient.agent.get.mockImplementation(async () => ({ data: { model: { providerID: 'sidecar', id: 'tiny-model' } } }));
    sdkClient.model.list.mockImplementation(async () => ({ data: [{ providerID: 'sidecar', id: 'tiny-model', enabled: false }] }));
    sdkClient.experimental.generate.text.mockImplementation(async () => ({ text: '{"subject":"feat: add a line","highlights":["adds a line"]}' }));

    const response = await handleSpecialGitBridgeMessage({
      id: 't2',
      type: 'api:git/commit-message',
      payload: { directory: '/repo' },
    }, { manager: { getApiUrl: () => 'http://opencode.test', getOpenCodeAuthHeaders: () => ({}) } }, {
      readSettings: () => ({}),
      execGit: mock(),
      readPromptOverrides: () => ({}),
    });

    expect(response.success).toBe(true);
    expect(sdkClient.experimental.generate.text.mock.calls[0][0].model).toEqual({ id: 'gpt-5-nano', providerID: 'zen' });
  });

  it('skips a saved free zen small model without a login, like the server resolver', async () => {
    gitService.getGitStatus.mockImplementation(async () => ({ files: [{ path: 'src/a.ts', index: ' ', working_dir: 'M' }] }));
    gitService.getGitLog.mockImplementation(async () => ({ all: [{ message: 'fix: earlier change' }] }));
    gitService.getGitDiff.mockImplementation(async () => ({ kind: 'diff', diff: 'diff --git a/src/a.ts b/src/a.ts\n+new line', submodule: null }));
    sdkClient.model.list.mockImplementation(async () => ({ data: [{ providerID: 'opencode', id: 'big-pickle', enabled: true, settings: { apiKey: 'public' } }] }));
    sdkClient.experimental.generate.text.mockImplementation(async () => ({ text: '{"subject":"feat: add a line","highlights":["adds a line"]}' }));

    const response = await handleSpecialGitBridgeMessage({
      id: 'zen1',
      type: 'api:git/commit-message',
      payload: { directory: '/repo' },
    }, { manager: { getApiUrl: () => 'http://opencode.test', getOpenCodeAuthHeaders: () => ({}) } }, {
      readSettings: () => ({ smallModelUseDefault: false, smallModelOverride: 'opencode/big-pickle' }),
      execGit: mock(),
      readPromptOverrides: () => ({}),
    });

    expect(response.success).toBe(true);
    expect(sdkClient.experimental.generate.text.mock.calls[0][0].model).toEqual({ id: 'gpt-5-nano', providerID: 'zen' });
  });

  it('keeps the configured small model when the catalog is not readable yet', async () => {
    // The first click of a cold start: OpenCode answers the model list before
    // the location's providers load, so the read fails. An unreadable catalog
    // is not an empty one — dropping the user's configured small model here
    // sent generation to the zen default the reporter cannot use.
    gitService.getGitStatus.mockImplementation(async () => ({ files: [{ path: 'src/a.ts', index: ' ', working_dir: 'M' }] }));
    gitService.getGitLog.mockImplementation(async () => ({ all: [{ message: 'fix: earlier change' }] }));
    gitService.getGitDiff.mockImplementation(async () => ({ kind: 'diff', diff: 'diff --git a/src/a.ts b/src/a.ts\n+new line', submodule: null }));
    sdkClient.model.list.mockImplementation(async () => { throw new Error('cold catalog'); });
    sdkClient.experimental.generate.text.mockImplementation(async () => ({ text: '{"subject":"feat: add a line","highlights":["adds a line"]}' }));

    const response = await handleSpecialGitBridgeMessage({
      id: 'cold1',
      type: 'api:git/commit-message',
      payload: { directory: '/repo' },
    }, { manager: { getApiUrl: () => 'http://opencode.test', getOpenCodeAuthHeaders: () => ({}) } }, {
      readSettings: () => ({ smallModelUseDefault: false, smallModelOverride: 'anthropic/claude-sonnet-4-5' }),
      execGit: mock(),
      readPromptOverrides: () => ({}),
    });

    expect(response.success).toBe(true);
    expect(sdkClient.experimental.generate.text.mock.calls[0][0].model).toEqual({ id: 'claude-sonnet-4-5', providerID: 'anthropic' });
  });

  it('carries the small-model thinking variant into generation', async () => {
    gitService.getGitStatus.mockImplementation(async () => ({ files: [{ path: 'src/a.ts', index: ' ', working_dir: 'M' }] }));
    gitService.getGitLog.mockImplementation(async () => ({ all: [{ message: 'fix: earlier change' }] }));
    gitService.getGitDiff.mockImplementation(async () => ({ kind: 'diff', diff: 'diff --git a/src/a.ts b/src/a.ts\n+new line', submodule: null }));
    sdkClient.model.list.mockImplementation(async () => ({
      data: [{ providerID: 'anthropic', id: 'claude-sonnet-4-5', variants: [{ id: 'high' }] }],
    }));
    sdkClient.experimental.generate.text.mockImplementation(async () => ({ text: '{"subject":"feat: add a line","highlights":["adds a line"]}' }));

    const response = await handleSpecialGitBridgeMessage({
      id: 'variant1',
      type: 'api:git/commit-message',
      payload: { directory: '/repo' },
    }, { manager: { getApiUrl: () => 'http://opencode.test', getOpenCodeAuthHeaders: () => ({}) } }, {
      readSettings: () => ({
        smallModelUseDefault: false,
        smallModelOverride: 'anthropic/claude-sonnet-4-5',
        smallModelVariant: 'high',
      }),
      execGit: mock(),
      readPromptOverrides: () => ({}),
    });

    expect(response.success).toBe(true);
    expect(sdkClient.experimental.generate.text.mock.calls[0][0].model).toEqual({
      id: 'claude-sonnet-4-5',
      providerID: 'anthropic',
      variant: 'high',
    });
  });

  it('keeps the configured small model when the catalog comes back empty', async () => {
    // The other cold-start shape: the read succeeds but lists nothing yet.
    gitService.getGitStatus.mockImplementation(async () => ({ files: [{ path: 'src/a.ts', index: ' ', working_dir: 'M' }] }));
    gitService.getGitLog.mockImplementation(async () => ({ all: [{ message: 'fix: earlier change' }] }));
    gitService.getGitDiff.mockImplementation(async () => ({ kind: 'diff', diff: 'diff --git a/src/a.ts b/src/a.ts\n+new line', submodule: null }));
    sdkClient.model.list.mockImplementation(async () => ({ data: [] }));
    sdkClient.experimental.generate.text.mockImplementation(async () => ({ text: '{"subject":"feat: add a line","highlights":["adds a line"]}' }));

    const response = await handleSpecialGitBridgeMessage({
      id: 'cold2',
      type: 'api:git/commit-message',
      payload: { directory: '/repo' },
    }, { manager: { getApiUrl: () => 'http://opencode.test', getOpenCodeAuthHeaders: () => ({}) } }, {
      readSettings: () => ({ smallModelUseDefault: false, smallModelOverride: 'anthropic/claude-sonnet-4-5' }),
      execGit: mock(),
      readPromptOverrides: () => ({}),
    });

    expect(response.success).toBe(true);
    expect(sdkClient.experimental.generate.text.mock.calls[0][0].model).toEqual({ id: 'claude-sonnet-4-5', providerID: 'anthropic' });
  });

  it('keeps the configured small model when a partial catalog omits it', async () => {
    // A cold start can answer a non-empty list before every provider has
    // loaded. Only a model the catalog lists as disabled is rejected, the same
    // rule the server resolver applies.
    gitService.getGitStatus.mockImplementation(async () => ({ files: [{ path: 'src/a.ts', index: ' ', working_dir: 'M' }] }));
    gitService.getGitLog.mockImplementation(async () => ({ all: [{ message: 'fix: earlier change' }] }));
    gitService.getGitDiff.mockImplementation(async () => ({ kind: 'diff', diff: 'diff --git a/src/a.ts b/src/a.ts\n+new line', submodule: null }));
    sdkClient.model.list.mockImplementation(async () => ({ data: [{ providerID: 'other', id: 'some-model' }] }));
    sdkClient.experimental.generate.text.mockImplementation(async () => ({ text: '{"subject":"feat: add a line","highlights":["adds a line"]}' }));

    const response = await handleSpecialGitBridgeMessage({
      id: 'partial1',
      type: 'api:git/commit-message',
      payload: { directory: '/repo' },
    }, { manager: { getApiUrl: () => 'http://opencode.test', getOpenCodeAuthHeaders: () => ({}) } }, {
      readSettings: () => ({ smallModelUseDefault: false, smallModelOverride: 'anthropic/claude-sonnet-4-5' }),
      execGit: mock(),
      readPromptOverrides: () => ({}),
    });

    expect(response.success).toBe(true);
    expect(sdkClient.experimental.generate.text.mock.calls[0][0].model).toEqual({ id: 'claude-sonnet-4-5', providerID: 'anthropic' });
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
    sdkClient.experimental.generate.text.mockImplementation(async () => {
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
    const unavailable = {
      _tag: 'ModelNotFoundError',
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4-5',
      message: 'Model not found: anthropic/claude-sonnet-4-5',
    };
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
      sdkClient.experimental.generate.text.mockImplementation(async () => {
        calls += 1;
        if (calls <= 2) throw unavailable;
        return { text: '{"title":"PR title","body":"PR body"}' };
      });

      const response = await request();

      expect(response.success).toBe(true);
      expect(sdkClient.experimental.generate.text).toHaveBeenCalledTimes(3);
      setUnavailableRetryDelaysForTest();
    });

    it('gives up once the backoff runs out and never retries other errors', async () => {
      sdkClient.experimental.generate.text.mockImplementation(async () => { throw unavailable; });
      expect((await request()).success).toBe(false);
      expect(sdkClient.experimental.generate.text).toHaveBeenCalledTimes(3);

      sdkClient.experimental.generate.text.mockReset();
      sdkClient.experimental.generate.text.mockImplementation(async () => { throw { _tag: 'InvalidRequestError', message: 'Invalid prompt' }; });
      await request();
      expect(sdkClient.experimental.generate.text).toHaveBeenCalledTimes(1);
      setUnavailableRetryDelaysForTest();
    });
  });
});
